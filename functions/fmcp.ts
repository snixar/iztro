/**
 * iztro MCP Server - Cloudflare Pages Functions
 *
 * 紫微斗数星盘 MCP 服务端点，所有请求通过 /fmcp 处理。
 * 使用 Model Context Protocol (MCP) Streamable HTTP 传输协议。
 */

import { bySolar, byLunar, withOptions, getZodiacBySolarDate, getSignBySolarDate, getSignByLunarDate, getMajorStarBySolarDate } from '../src/astro/astro';
import type { GenderName, PalaceName, Mutagen, StarName } from '../src/i18n/types';
import { timeToIndex } from '../src/utils';

// ===== JSON-RPC Types =====

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

// ===== MCP Server Info =====

const SERVER_INFO = {
  name: 'iztro-mcp',
  version: '2.5.8',
  description: '紫微斗数 (Zi Wei Dou Shu) 星盘排盘服务',
};

const PROTOCOL_VERSION = '2025-03-26';

// ===== Helper: compute astrolabe from tool args =====

function buildAstrolabe(args: Record<string, unknown>) {
  const dateType = (args.dateType as string) || 'solar';
  const dateStr = args.dateStr as string;
  const timeIndex = args.timeIndex as number;
  const gender = args.gender as GenderName;
  const isLeapMonth = args.isLeapMonth as boolean | undefined;
  const fixLeap = (args.fixLeap as boolean) !== false;
  const language = args.language as string | undefined;
  const astroType = args.astroType as string | undefined;
  const yearDivide = args.yearDivide as string | undefined;
  const algorithm = args.algorithm as string | undefined;
  const dayDivide = args.dayDivide as string | undefined;

  return withOptions({
    type: dateType as 'solar' | 'lunar',
    dateStr,
    timeIndex,
    gender,
    isLeapMonth,
    fixLeap,
    language,
    astroType: astroType as 'heaven' | 'earth' | 'human' | undefined,
    config: {
      ...(yearDivide ? { yearDivide: yearDivide as 'normal' | 'exact' } : {}),
      ...(algorithm ? { algorithm: algorithm as 'default' | 'zhongzhou' } : {}),
      ...(dayDivide ? { dayDivide: dayDivide as 'current' | 'forward' } : {}),
    },
  });
}

// ===== Helper: serialize FunctionalStar array =====

function serializeStar(s: { name: string; type: string; scope: string; brightness?: string; mutagen?: string }) {
  return {
    name: s.name,
    type: s.type,
    scope: s.scope,
    ...(s.brightness ? { brightness: s.brightness } : {}),
    ...(s.mutagen ? { mutagen: s.mutagen } : {}),
  };
}

// ===== Tool Definitions =====

const TOOLS = [
  {
    name: 'getAstrolabe',
    description:
      '获取紫微斗数完整星盘（排盘）。根据出生日期、时辰、性别计算完整的紫微斗数星盘，包括十二宫、主星、辅星、杂耀、长生十二神、博士十二神、将前十二神、岁前十二神、大限、小限、命主、身主、五行局。支持天盘/地盘/人盘，支持阳历/阴历输入。',
    inputSchema: {
      type: 'object',
      properties: {
        dateType: { type: 'string', enum: ['solar', 'lunar'], description: '日期类型：solar=阳历，lunar=阴历。默认为 solar。' },
        dateStr: { type: 'string', description: '出生日期。阳历 YYYY-M-D（如 2000-1-15），阴历 YYYY-M-D（如 2000-7-17）。' },
        timeIndex: { type: 'integer', description: '时辰索引。0=早子时(23~01), 1=丑时(01~03), 2=寅时(03~05), 3=卯时(05~07), 4=辰时(07~09), 5=巳时(09~11), 6=午时(11~13), 7=未时(13~15), 8=申时(15~17), 9=酉时(17~19), 10=戌时(19~21), 11=亥时(21~23), 12=晚子时(23~24)。', minimum: 0, maximum: 12 },
        gender: { type: 'string', description: '性别：男 或 女（也支持 male/female）。' },
        isLeapMonth: { type: 'boolean', description: '是否闰月。仅 dateType=lunar 时有效。默认 false。' },
        fixLeap: { type: 'boolean', description: '是否修正闰月。修正后农历15日（含）前算当月，之后算下月。默认 true。' },
        language: { type: 'string', enum: ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'vi-VN'], description: '输出语言，默认 zh-CN。' },
        astroType: { type: 'string', enum: ['heaven', 'earth', 'human'], description: '星盘类型：heaven=天盘（默认），earth=地盘，human=人盘。' },
        yearDivide: { type: 'string', enum: ['normal', 'exact'], description: '年分界：normal=正月初一（默认），exact=立春。' },
        algorithm: { type: 'string', enum: ['default', 'zhongzhou'], description: '安星法：default=通行版（默认），zhongzhou=中州派。' },
        dayDivide: { type: 'string', enum: ['current', 'forward'], description: '晚子时处理：current=算当日，forward=算来日。默认 forward。' },
      },
      required: ['dateStr', 'timeIndex', 'gender'],
    },
  },
  {
    name: 'getPalaceInfo',
    description:
      '查询星盘中指定宫位的详细信息。需要提供出生参数和宫位名称（如"命宫""夫妻""财帛""官禄"等），返回该宫位的所有星耀分布、天干地支、大限、小限、长生十二神等信息。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        palaceName: { type: 'string', description: '宫位名称：命宫、兄弟、夫妻、子女、财帛、疾厄、迁移、仆役、官禄、田宅、福德、父母、身宫。' },
        fixLeap: { type: 'boolean', description: '是否修正闰月，默认 true。' },
        language: { type: 'string', description: '输出语言。' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'palaceName'],
    },
  },
  {
    name: 'getStarInfo',
    description:
      '查询指定星耀在星盘中的位置和状态。返回该星耀所在的宫位、亮度、是否产生四化，以及该宫位的三方四正信息。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        starName: { type: 'string', description: '星耀名称，如：紫微、天机、太阳、武曲、天同、廉贞、天府、太阴、贪狼、巨门、天相、天梁、七杀、破军、左辅、右弼、文昌、文曲、天魁、天钺、禄存、天马、擎羊、陀罗、火星、铃星、地空、地劫等。' },
        fixLeap: { type: 'boolean', description: '是否修正闰月，默认 true。' },
        language: { type: 'string', description: '输出语言。' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'starName'],
    },
  },
  {
    name: 'checkPalaceHasStars',
    description:
      '检查某个宫位是否包含指定的星耀（全部命中才返回 true）。用于判断"命宫是否有紫微""夫妻宫是否有左辅右弼"等问题。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        palaceName: { type: 'string', description: '宫位名称。' },
        starNames: { type: 'array', items: { type: 'string' }, description: '要检查的星耀名称列表。' },
        checkMode: { type: 'string', enum: ['all', 'any'], description: '检查模式：all=全部命中才返回 true（默认），any=命中任意一个就返回 true。' },
        fixLeap: { type: 'boolean' },
        language: { type: 'string' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'palaceName', 'starNames'],
    },
  },
  {
    name: 'getSurroundedPalaces',
    description:
      '获取指定宫位的三方四正（本宫、对宫、财帛位、官禄位）。三方四正是紫微斗数星盘分析的核心概念，用于综合判断一个宫位的吉凶。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        palaceName: { type: 'string', description: '目标宫位名称。' },
        fixLeap: { type: 'boolean', description: '是否修正闰月。' },
        language: { type: 'string' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'palaceName'],
    },
  },
  {
    name: 'checkPalaceMutagen',
    description:
      '检查某个宫位是否有指定的生年四化（禄、权、科、忌）。生年四化由出生年天干决定，是解盘的重要依据。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        palaceName: { type: 'string', description: '宫位名称。' },
        mutagen: { type: 'string', enum: ['禄', '权', '科', '忌'], description: '四化名称。' },
        fixLeap: { type: 'boolean' },
        language: { type: 'string' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'palaceName', 'mutagen'],
    },
  },
  {
    name: 'checkIsEmptyPalace',
    description:
      '检查某个宫位是否为空宫（没有主星）。空宫在紫微斗数中有特殊含义——通常借对宫主星来看。可传入排除星耀列表（某些派别认为有特定辅星不算空宫）。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        palaceName: { type: 'string', description: '宫位名称。' },
        excludeStars: { type: 'array', items: { type: 'string' }, description: '排除星耀列表（有这些星耀时不算空宫）。可选。' },
        fixLeap: { type: 'boolean' },
        language: { type: 'string' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'palaceName'],
    },
  },
  {
    name: 'getFlyingMutagen',
    description:
      '飞化分析：判断源宫位的天干是否使指定四化飞入目标宫位。例如"命宫是否化禄入财帛宫"——这是紫微斗数高级分析（飞星四化）的核心功能。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        fromPalace: { type: 'string', description: '源宫位名称（以该宫天干起四化）。' },
        toPalace: { type: 'string', description: '目标宫位名称（检查四化星是否飞入）。' },
        mutagens: { type: 'array', items: { type: 'string', enum: ['禄', '权', '科', '忌'] }, description: '要检查的四化列表。默认检查全部四个。若传多个：checkMode=all 则全部要飞入，checkMode=any 则命中一个即返回 true。' },
        checkMode: { type: 'string', enum: ['all', 'any'], description: '检查模式：all=全部命中（默认），any=命中任意一个。' },
        fixLeap: { type: 'boolean' },
        language: { type: 'string' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'fromPalace', 'toPalace'],
    },
  },
  {
    name: 'checkSurroundedHasStars',
    description:
      '检查指定宫位的三方四正（本宫+对宫+财帛位+官禄位）是否包含指定星耀。用于判断"命宫三方四正是否有紫微""夫妻宫三方四正是否有煞星"等问题。',
    inputSchema: {
      type: 'object',
      properties: {
        dateStr: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        palaceName: { type: 'string', description: '目标宫位名称。' },
        starNames: { type: 'array', items: { type: 'string' }, description: '要检查的星耀名称列表。' },
        checkMode: { type: 'string', enum: ['all', 'any'], description: '检查模式：all=全部命中（默认），any=命中任意一个。' },
        fixLeap: { type: 'boolean' },
        language: { type: 'string' },
      },
      required: ['dateStr', 'timeIndex', 'gender', 'palaceName', 'starNames'],
    },
  },
  {
    name: 'getHoroscope',
    description:
      '获取指定日期的运限数据。包括大限、小限、流年、流月、流日、流时，各运限的宫位分布、四化星、流耀信息。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: { type: 'string', description: '出生阳历日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '出生时辰索引 0-12。' },
        gender: { type: 'string', description: '性别：男 或 女。' },
        targetDate: { type: 'string', description: '要查询运限的目标日期 YYYY-M-D，默认为当前日期。' },
        targetTimeIndex: { type: 'integer', description: '目标时辰索引 0-12。若不指定则自动推算。' },
        fixLeap: { type: 'boolean', description: '是否修正闰月，默认 true。' },
        language: { type: 'string', description: '输出语言。' },
      },
      required: ['solarDate', 'timeIndex', 'gender'],
    },
  },
  {
    name: 'getMajorStar',
    description: '获取命宫主星。如果命宫为空宫，返回对宫主星。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: { type: 'string', description: '阳历出生日期 YYYY-M-D。' },
        timeIndex: { type: 'integer', description: '出生时辰索引 0-12。' },
        fixLeap: { type: 'boolean', description: '是否修正闰月，默认 true。' },
        language: { type: 'string' },
      },
      required: ['solarDate', 'timeIndex'],
    },
  },
  {
    name: 'getZodiac',
    description: '通过阳历日期获取生肖。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: { type: 'string', description: '阳历日期 YYYY-M-D。' },
        language: { type: 'string', description: '输出语言。' },
      },
      required: ['solarDate'],
    },
  },
  {
    name: 'getSign',
    description: '通过阳历日期获取星座。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: { type: 'string', description: '阳历日期 YYYY-M-D。' },
        language: { type: 'string', description: '输出语言。' },
      },
      required: ['solarDate'],
    },
  },
  {
    name: 'getSignByLunarDate',
    description: '通过农历日期获取星座。',
    inputSchema: {
      type: 'object',
      properties: {
        lunarDate: { type: 'string', description: '农历日期 YYYY-M-D。' },
        isLeapMonth: { type: 'boolean', description: '是否闰月。默认 false。' },
        language: { type: 'string' },
      },
      required: ['lunarDate'],
    },
  },
  {
    name: 'getTimeIndex',
    description: '将24小时制的小时数转换为紫微斗数的时辰索引（0-12）。例如 3 点（寅时）→ 2，14 点（未时）→ 7，23 点（晚子时）→ 12。',
    inputSchema: {
      type: 'object',
      properties: {
        hour: { type: 'integer', description: '24小时制的小时数 0-23。', minimum: 0, maximum: 23 },
      },
      required: ['hour'],
    },
  },
];

// ===== MCP Protocol Handlers =====

function handleInitialize(req: JsonRpcRequest): Response {
  return jsonRpcResult(req.id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  });
}

function handleToolsList(req: JsonRpcRequest): Response {
  return jsonRpcResult(req.id, { tools: TOOLS });
}

async function handleToolsCall(req: JsonRpcRequest): Promise<Response> {
  const params = req.params as unknown as McpToolCallParams | undefined;
  if (!params) {
    return jsonRpcError(req.id, -32602, 'Invalid params');
  }

  const { name, arguments: args } = params;

  try {
    let result: unknown;

    switch (name) {
      // ===== 排盘 =====
      case 'getAstrolabe': {
        const astrolabe = buildAstrolabe(args);
        result = JSON.parse(JSON.stringify(astrolabe));
        break;
      }

      // ===== 宫位查询 =====
      case 'getPalaceInfo': {
        const astrolabe = buildAstrolabe(args);
        const palaceName = args.palaceName as string;
        const palace = astrolabe.palace(palaceName as PalaceName);
        if (!palace) throw new Error(`宫位 "${palaceName}" 不存在，可选：命宫、兄弟、夫妻、子女、财帛、疾厄、迁移、仆役、官禄、田宅、福德、父母、身宫`);

        result = {
          index: palace.index,
          name: palace.name,
          isBodyPalace: palace.isBodyPalace,
          isOriginalPalace: palace.isOriginalPalace,
          heavenlyStem: palace.heavenlyStem,
          earthlyBranch: palace.earthlyBranch,
          majorStars: palace.majorStars.map(serializeStar),
          minorStars: palace.minorStars.map(serializeStar),
          adjectiveStars: palace.adjectiveStars.map(serializeStar),
          changsheng12: palace.changsheng12,
          boshi12: palace.boshi12,
          jiangqian12: palace.jiangqian12,
          suiqian12: palace.suiqian12,
          decadal: palace.decadal,
          ages: palace.ages,
        };
        break;
      }

      // ===== 星耀查询 =====
      case 'getStarInfo': {
        const astrolabe = buildAstrolabe(args);
        const starName = args.starName as string;
        const star = astrolabe.star(starName as StarName);
        const palace = star.palace();

        result = {
          star: serializeStar(star),
          palace: palace ? {
            name: palace.name,
            index: palace.index,
            heavenlyStem: palace.heavenlyStem,
            earthlyBranch: palace.earthlyBranch,
            isBodyPalace: palace.isBodyPalace,
          } : null,
          withBrightness: star.brightness || '无亮度数据',
          withMutagen: star.mutagen || '无四化',
        };
        break;
      }

      // ===== 宫位含星检查 =====
      case 'checkPalaceHasStars': {
        const astrolabe = buildAstrolabe(args);
        const palaceName = args.palaceName as string;
        const starNames = args.starNames as string[];
        const checkMode = (args.checkMode as string) || 'all';
        const palace = astrolabe.palace(palaceName as PalaceName);
        if (!palace) throw new Error(`宫位 "${palaceName}" 不存在`);

        const matched = checkMode === 'any'
          ? palace.hasOneOf(starNames as StarName[])
          : palace.has(starNames as StarName[]);

        result = {
          palaceName: palace.name,
          starNames,
          checkMode,
          result: matched,
        };
        break;
      }

      // ===== 三方四正 =====
      case 'getSurroundedPalaces': {
        const astrolabe = buildAstrolabe(args);
        const palaceName = args.palaceName as string;
        const sp = astrolabe.surroundedPalaces(palaceName as PalaceName);

        result = {
          target: { name: sp.target.name, index: sp.target.index, heavenlyStem: sp.target.heavenlyStem, earthlyBranch: sp.target.earthlyBranch, majorStars: sp.target.majorStars.map(serializeStar), minorStars: sp.target.minorStars.map(serializeStar) },
          opposite: { name: sp.opposite.name, index: sp.opposite.index, heavenlyStem: sp.opposite.heavenlyStem, earthlyBranch: sp.opposite.earthlyBranch, majorStars: sp.opposite.majorStars.map(serializeStar), minorStars: sp.opposite.minorStars.map(serializeStar) },
          wealth: { name: sp.wealth.name, index: sp.wealth.index, heavenlyStem: sp.wealth.heavenlyStem, earthlyBranch: sp.wealth.earthlyBranch, majorStars: sp.wealth.majorStars.map(serializeStar), minorStars: sp.wealth.minorStars.map(serializeStar) },
          career: { name: sp.career.name, index: sp.career.index, heavenlyStem: sp.career.heavenlyStem, earthlyBranch: sp.career.earthlyBranch, majorStars: sp.career.majorStars.map(serializeStar), minorStars: sp.career.minorStars.map(serializeStar) },
        };
        break;
      }

      // ===== 生年四化检查 =====
      case 'checkPalaceMutagen': {
        const astrolabe = buildAstrolabe(args);
        const palaceName = args.palaceName as string;
        const mutagen = args.mutagen as string;
        const palace = astrolabe.palace(palaceName as PalaceName);
        if (!palace) throw new Error(`宫位 "${palaceName}" 不存在`);

        result = {
          palaceName: palace.name,
          mutagen,
          result: palace.hasMutagen(mutagen as Mutagen),
        };
        break;
      }

      // ===== 空宫检查 =====
      case 'checkIsEmptyPalace': {
        const astrolabe = buildAstrolabe(args);
        const palaceName = args.palaceName as string;
        const excludeStars = args.excludeStars as string[] | undefined;
        const palace = astrolabe.palace(palaceName as PalaceName);
        if (!palace) throw new Error(`宫位 "${palaceName}" 不存在`);

        const isEmpty = palace.isEmpty(excludeStars as StarName[] | undefined);

        result = {
          palaceName: palace.name,
          isEmpty,
          majorStars: palace.majorStars.filter(s => s.type === 'major').map(s => s.name),
          ...(excludeStars ? { excludeStars } : {}),
        };
        break;
      }

      // ===== 飞化分析 =====
      case 'getFlyingMutagen': {
        const astrolabe = buildAstrolabe(args);
        const fromPalace = args.fromPalace as string;
        const toPalace = args.toPalace as string;
        const mutagens = (args.mutagens as string[] | undefined) || ['禄', '权', '科', '忌'];
        const checkMode = (args.checkMode as string) || 'all';

        const from = astrolabe.palace(fromPalace as PalaceName);
        if (!from) throw new Error(`源宫位 "${fromPalace}" 不存在`);

        const to = astrolabe.palace(toPalace as PalaceName);
        if (!to) throw new Error(`目标宫位 "${toPalace}" 不存在`);

        const flies = checkMode === 'any'
          ? from.fliesOneOfTo(toPalace as PalaceName, mutagens as Mutagen[])
          : from.fliesTo(toPalace as PalaceName, mutagens as Mutagen[]);

        result = {
          from: { name: from.name, heavenlyStem: from.heavenlyStem },
          to: { name: to.name },
          mutagens,
          checkMode,
          result: flies,
        };
        break;
      }

      // ===== 三方四正含星检查 =====
      case 'checkSurroundedHasStars': {
        const astrolabe = buildAstrolabe(args);
        const palaceName = args.palaceName as string;
        const starNames = args.starNames as string[];
        const checkMode = (args.checkMode as string) || 'all';
        const sp = astrolabe.surroundedPalaces(palaceName as PalaceName);

        const matched = checkMode === 'any'
          ? sp.haveOneOf(starNames as StarName[])
          : sp.have(starNames as StarName[]);

        result = {
          targetPalace: palaceName,
          starNames,
          checkMode,
          result: matched,
        };
        break;
      }

      // ===== 运限 =====
      case 'getHoroscope': {
        const solarDate = args.solarDate as string;
        const timeIndex = args.timeIndex as number;
        const gender = args.gender as GenderName;
        const targetDate = (args.targetDate as string) || undefined;
        const targetTimeIndex = args.targetTimeIndex as number | undefined;
        const fixLeap = (args.fixLeap as boolean) !== false;
        const language = args.language as string | undefined;

        const astrolabe = bySolar(solarDate, timeIndex, gender, fixLeap, language);
        const horoscope = astrolabe.horoscope(targetDate, targetTimeIndex);

        result = {
          solarDate: horoscope.solarDate,
          lunarDate: horoscope.lunarDate,
          decadal: horoscope.decadal,
          age: horoscope.age,
          yearly: horoscope.yearly,
          monthly: horoscope.monthly,
          daily: horoscope.daily,
          hourly: horoscope.hourly,
        };
        break;
      }

      // ===== 命宫主星 =====
      case 'getMajorStar': {
        const solarDate = args.solarDate as string;
        const timeIndex = args.timeIndex as number;
        const fixLeap = (args.fixLeap as boolean) !== false;
        const language = args.language as string | undefined;
        result = { majorStar: getMajorStarBySolarDate(solarDate, timeIndex, fixLeap, language) };
        break;
      }

      // ===== 生肖 =====
      case 'getZodiac': {
        result = { zodiac: getZodiacBySolarDate(args.solarDate as string, args.language as string | undefined) };
        break;
      }

      // ===== 星座（阳历） =====
      case 'getSign': {
        result = { sign: getSignBySolarDate(args.solarDate as string, args.language as string | undefined) };
        break;
      }

      // ===== 星座（农历） =====
      case 'getSignByLunarDate': {
        const lunarDate = args.lunarDate as string;
        const isLeapMonth = args.isLeapMonth as boolean | undefined;
        const language = args.language as string | undefined;
        result = { sign: getSignByLunarDate(lunarDate, isLeapMonth, language) };
        break;
      }

      // ===== 时辰转换 =====
      case 'getTimeIndex': {
        const hour = args.hour as number;
        result = {
          hour,
          timeIndex: timeToIndex(hour),
          timeName: ['早子时', '丑时', '寅时', '卯时', '辰时', '巳时', '午时', '未时', '申时', '酉时', '戌时', '亥时', '晚子时'][timeToIndex(hour)],
        };
        break;
      }

      default:
        return jsonRpcError(req.id, -32601, `Unknown tool: ${name}`);
    }

    return jsonRpcResult(req.id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcResult(req.id, {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    });
  }
}

// ===== JSON-RPC Helpers =====

function jsonRpcResult(id: string | number | undefined | null, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result } satisfies JsonRpcResponse),
    { status: 200, headers: corsHeaders({ 'Content-Type': 'application/json' }) },
  );
}

function jsonRpcError(id: string | number | undefined | null, code: number, message: string, data?: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } } satisfies JsonRpcResponse),
    { status: code === -32601 ? 404 : 400, headers: corsHeaders({ 'Content-Type': 'application/json' }) },
  );
}

// ===== CORS =====

function corsHeaders(base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Accept',
  };
}

// ===== Main Request Handler =====

export async function onRequest(context: { request: Request; env: Record<string, string> }): Promise<Response> {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders({}) });
  }

  if (request.method === 'GET') {
    return new Response(
      JSON.stringify({
        server: SERVER_INFO,
        protocol: 'MCP Streamable HTTP',
        protocolVersion: PROTOCOL_VERSION,
        endpoint: '/fmcp',
        usage: 'POST JSON-RPC 2.0 to use MCP tools.',
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      }, null, 2),
      { status: 200, headers: corsHeaders({ 'Content-Type': 'application/json' }) },
    );
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders({ 'Content-Type': 'text/plain' }) });
  }

  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: invalid JSON');
  }

  if (body.jsonrpc !== '2.0') {
    return jsonRpcError(body.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }

  const { method } = body;

  if (method === 'initialize') return handleInitialize(body);
  if (method === 'notifications/initialized') return new Response(null, { status: 202, headers: corsHeaders({}) });
  if (method === 'tools/list') return handleToolsList(body);
  if (method === 'tools/call') return handleToolsCall(body);
  if (method === 'ping') return jsonRpcResult(body.id, {});

  return jsonRpcError(body.id, -32601, `Method not found: ${method}`);
}
