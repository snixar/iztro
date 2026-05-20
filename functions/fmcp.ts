/**
 * iztro MCP Server - Cloudflare Pages Functions
 *
 * 紫微斗数星盘 MCP 服务端点，所有请求通过 /fmcp 处理。
 * 使用 Model Context Protocol (MCP) Streamable HTTP 传输协议。
 */

import { bySolar, byLunar, withOptions, getZodiacBySolarDate, getSignBySolarDate, getMajorStarBySolarDate } from '../src/astro/astro';
import type { GenderName } from '../src/i18n/types';

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

// ===== Tool Definitions =====

const TOOLS = [
  {
    name: 'getAstrolabe',
    description:
      '获取紫微斗数完整星盘（排盘）。根据出生日期、时辰、性别计算完整的紫微斗数星盘，包括十二宫、主星、辅星、杂耀、长生十二神、博士十二神、将前十二神、岁前十二神、大限、小限、命主、身主、五行局等信息。支持天盘/地盘/人盘。',
    inputSchema: {
      type: 'object',
      properties: {
        dateType: {
          type: 'string',
          enum: ['solar', 'lunar'],
          description: '日期类型：solar=阳历，lunar=阴历。默认为solar。',
        },
        dateStr: {
          type: 'string',
          description: '出生日期字符串。阳历格式：YYYY-M-D（如 2000-1-15）；阴历格式：YYYY-M-D（如 2000-7-17）。',
        },
        timeIndex: {
          type: 'integer',
          description: '出生时辰索引。0=早子时(23:00~01:00)，1=丑时(01:00~03:00)，2=寅时(03:00~05:00)，3=卯时(05:00~07:00)，4=辰时(07:00~09:00)，5=巳时(09:00~11:00)，6=午时(11:00~13:00)，7=未时(13:00~15:00)，8=申时(15:00~17:00)，9=酉时(17:00~19:00)，10=戌时(19:00~21:00)，11=亥时(21:00~23:00)，12=晚子时(23:00~24:00)。',
          minimum: 0,
          maximum: 12,
        },
        gender: {
          type: 'string',
          description: '性别："男" 或 "女"（也支持 male/female）。',
        },
        isLeapMonth: {
          type: 'boolean',
          description: '是否闰月。仅当 dateType=lunar 且该月有闰月时有效。默认 false。',
        },
        fixLeap: {
          type: 'boolean',
          description: '是否修正闰月。修正后，农历15日（含）之前算当月，15日之后算下月。默认 true。',
        },
        language: {
          type: 'string',
          enum: ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'vi-VN'],
          description: '输出语言。默认 zh-CN（简体中文）。',
        },
        astroType: {
          type: 'string',
          enum: ['heaven', 'earth', 'human'],
          description: '星盘类型（中州派三盘）：heaven=天盘（默认），earth=地盘（以身宫为命宫重排），human=人盘（以福德宫为命宫重排）。',
        },
        yearDivide: {
          type: 'string',
          enum: ['normal', 'exact'],
          description: '年份分界方式：normal=正月初一分界（默认），exact=立春分界。',
        },
        algorithm: {
          type: 'string',
          enum: ['default', 'zhongzhou'],
          description: '安星法派别：default=通行版安星法（默认），zhongzhou=中州派安星法。',
        },
        dayDivide: {
          type: 'string',
          enum: ['current', 'forward'],
          description: '晚子时处理：current=晚子时算当日，forward=晚子时算来日。默认 forward。',
        },
      },
      required: ['dateStr', 'timeIndex', 'gender'],
    },
  },
  {
    name: 'getHoroscope',
    description:
      '获取指定日期的运限数据。需要先提供出生信息来计算星盘，然后可以查询任意日期的运限（大限、流年、流月、流日、流时），包括各运限的宫位分布、四化星、流耀等信息。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '出生阳历日期 YYYY-M-D。',
        },
        timeIndex: {
          type: 'integer',
          description: '出生时辰索引 0-12。',
        },
        gender: {
          type: 'string',
          description: '性别：男 或 女。',
        },
        targetDate: {
          type: 'string',
          description: '要查询运限的目标日期 YYYY-M-D，默认为当前日期。',
        },
        targetTimeIndex: {
          type: 'integer',
          description: '目标日期的时辰索引 0-12，若不指定则根据目标日期时间自动推算。',
        },
        fixLeap: {
          type: 'boolean',
          description: '是否修正闰月，默认 true。',
        },
        language: {
          type: 'string',
          enum: ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'vi-VN'],
          description: '输出语言。',
        },
      },
      required: ['solarDate', 'timeIndex', 'gender'],
    },
  },
  {
    name: 'getMajorStar',
    description:
      '获取命宫主星。通过阳历出生日期和时辰，快速查询命宫（灵魂之宫）的主星。如果命宫为空宫，则返回对宫主星。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历出生日期 YYYY-M-D。',
        },
        timeIndex: {
          type: 'integer',
          description: '出生时辰索引 0-12。',
        },
        fixLeap: {
          type: 'boolean',
          description: '是否修正闰月，默认 true。',
        },
        language: {
          type: 'string',
          description: '输出语言。',
        },
      },
      required: ['solarDate', 'timeIndex'],
    },
  },
  {
    name: 'getZodiac',
    description: '通过阳历日期获取生肖（十二生肖）。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历日期 YYYY-M-D。',
        },
        language: {
          type: 'string',
          description: '输出语言，默认 zh-CN。',
        },
      },
      required: ['solarDate'],
    },
  },
  {
    name: 'getSign',
    description: '通过阳历日期获取西方星座（如狮子座、处女座等）。',
    inputSchema: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历日期 YYYY-M-D。',
        },
        language: {
          type: 'string',
          description: '输出语言，默认 zh-CN。',
        },
      },
      required: ['solarDate'],
    },
  },
];

// ===== MCP Protocol Handlers =====

function handleInitialize(req: JsonRpcRequest): Response {
  return jsonRpcResult(req.id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: SERVER_INFO,
  });
}

function handleToolsList(req: JsonRpcRequest): Response {
  return jsonRpcResult(req.id, {
    tools: TOOLS,
  });
}

async function handleToolsCall(req: JsonRpcRequest): Promise<Response> {
  const params = req.params as unknown as McpToolCallParams | undefined;
  if (!params) {
    return jsonRpcError(req.id, -32602, 'Invalid params: missing name and arguments');
  }

  const { name, arguments: args } = params;

  try {
    let result: unknown;

    switch (name) {
      case 'getAstrolabe': {
        const dateType = (args.dateType as string) || 'solar';
        const dateStr = args.dateStr as string;
        const timeIndex = args.timeIndex as number;
        const gender = args.gender as GenderName;
        const isLeapMonth = args.isLeapMonth as boolean | undefined;
        const fixLeap = args.fixLeap as boolean | undefined;
        const language = args.language as string | undefined;
        const astroType = args.astroType as string | undefined;
        const yearDivide = args.yearDivide as string | undefined;
        const algorithm = args.algorithm as string | undefined;
        const dayDivide = args.dayDivide as string | undefined;

        const astrolabe = withOptions({
          type: dateType as 'solar' | 'lunar',
          dateStr,
          timeIndex,
          gender,
          isLeapMonth,
          fixLeap: fixLeap !== false,
          language,
          astroType: astroType as 'heaven' | 'earth' | 'human' | undefined,
          config: {
            ...(yearDivide ? { yearDivide: yearDivide as 'normal' | 'exact' } : {}),
            ...(algorithm ? { algorithm: algorithm as 'default' | 'zhongzhou' } : {}),
            ...(dayDivide ? { dayDivide: dayDivide as 'current' | 'forward' } : {}),
          },
        });

        result = JSON.parse(JSON.stringify(astrolabe));
        break;
      }

      case 'getHoroscope': {
        const solarDate = args.solarDate as string;
        const timeIndex = args.timeIndex as number;
        const gender = args.gender as GenderName;
        const targetDate = (args.targetDate as string) || undefined;
        const targetTimeIndex = args.targetTimeIndex as number | undefined;
        const fixLeap = args.fixLeap as boolean | undefined;
        const language = args.language as string | undefined;

        const astrolabe = bySolar(solarDate, timeIndex, gender, fixLeap !== false, language);
        const horoscope = astrolabe.horoscope(targetDate, targetTimeIndex);

        // Serialize horoscope data (strip methods from the FunctionalHoroscope instance)
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

      case 'getMajorStar': {
        const solarDate = args.solarDate as string;
        const timeIndex = args.timeIndex as number;
        const fixLeap = args.fixLeap as boolean | undefined;
        const language = args.language as string | undefined;

        const stars = getMajorStarBySolarDate(solarDate, timeIndex, fixLeap !== false, language);
        result = { majorStar: stars };
        break;
      }

      case 'getZodiac': {
        const solarDate = args.solarDate as string;
        const language = args.language as string | undefined;

        const zodiac = getZodiacBySolarDate(solarDate, language);
        result = { zodiac };
        break;
      }

      case 'getSign': {
        const solarDate = args.solarDate as string;
        const language = args.language as string | undefined;

        const sign = getSignBySolarDate(solarDate, language);
        result = { sign };
        break;
      }

      default:
        return jsonRpcError(req.id, -32601, `Unknown tool: ${name}`);
    }

    return jsonRpcResult(req.id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcResult(req.id, {
      content: [
        {
          type: 'text',
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    });
  }
}

// ===== JSON-RPC Helpers =====

function jsonRpcResult(id: string | number | undefined | null, result: unknown): Response {
  const body: JsonRpcResponse = {
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'application/json',
    }),
  });
}

function jsonRpcError(
  id: string | number | undefined | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  const body: JsonRpcResponse = {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
  return new Response(JSON.stringify(body), {
    status: code === -32601 ? 404 : 400,
    headers: corsHeaders({
      'Content-Type': 'application/json',
    }),
  });
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

export async function onRequest(context: {
  request: Request;
  env: Record<string, string>;
}): Promise<Response> {
  const { request } = context;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders({}),
    });
  }

  // GET returns server info for debugging
  if (request.method === 'GET') {
    return new Response(
      JSON.stringify(
        {
          server: SERVER_INFO,
          protocol: 'MCP Streamable HTTP',
          protocolVersion: PROTOCOL_VERSION,
          endpoint: '/fmcp',
          usage: 'Send POST requests with JSON-RPC 2.0 body to use MCP tools.',
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: corsHeaders({ 'Content-Type': 'application/json' }),
      },
    );
  }

  // Only POST for MCP protocol
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: corsHeaders({ 'Content-Type': 'text/plain' }),
    });
  }

  // Parse JSON-RPC body
  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: invalid JSON');
  }

  if (body.jsonrpc !== '2.0') {
    return jsonRpcError(body.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }

  // Route MCP methods
  const { method } = body;

  if (method === 'initialize') {
    return handleInitialize(body);
  }

  if (method === 'notifications/initialized') {
    return new Response(null, {
      status: 202,
      headers: corsHeaders({}),
    });
  }

  if (method === 'tools/list') {
    return handleToolsList(body);
  }

  if (method === 'tools/call') {
    return handleToolsCall(body);
  }

  if (method === 'ping') {
    return jsonRpcResult(body.id, {});
  }

  return jsonRpcError(body.id, -32601, `Method not found: ${method}`);
}
