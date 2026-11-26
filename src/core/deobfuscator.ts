import vm from 'node:vm';
import { ComciParseError } from './errors.js';
import type { ComciFieldKeys, ComciSessionConfig } from './types.js';

const OBFUSCATED_BLOCK_RE =
  /(?:\/\*[^*]*\*\/)?\(function\(a,k\)\{var s=[^;]*;for\([^)]*\)\{if\([^)]*\)\{[^}]*\}[^;]*;for\([^)]*\)\{[^}]*\}\}\(0,eval\)\(s\);\}\)\((\[\[[\s\S]*?\]\]),\s*(\d+)\);/g;

/**
 * Decodes nested `hour-obfuscated-v2` / `hour-ajax-obfuscated-v1` script blocks
 * without executing arbitrary code in the host realm.
 */
export function deobfuscateScriptText(input: string, maxPasses = 5): string {
  let current = input;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    current = current.replace(OBFUSCATED_BLOCK_RE, (_full, arrJson: string, keyStr: string) => {
      changed = true;
      const arr = JSON.parse(arrJson) as Array<[number, string]>;
      const k = Number(keyStr);
      let out = '';
      for (const [flag, val] of arr) {
        if (flag) {
          out += val;
        } else {
          for (let j = 0; j < val.length; j += 4) {
            const code = Number.parseInt(val.slice(j, j + 4), 16) ^ ((k + (j / 4) * 13) & 255);
            out += String.fromCharCode(code);
          }
        }
      }
      return out;
    });
    if (!changed) break;
  }
  return current;
}

/**
 * Safely evaluates a pure string-building JS expression (e.g. `String.fromCharCode(...)`
 * or `(function(a){return ...})([...])`) in a locked-down VM context.
 */
export function evalPureStringExpression(expr: string): string {
  const trimmed = expr.trim();
  const forbidden = /\b(process|global|globalThis|require|import|eval|Function|constructor|prototype|__proto__|fetch|XMLHttpRequest|window|document)\b/;
  if (forbidden.test(trimmed)) {
    throw new ComciParseError(`Unsafe key expression detected: ${trimmed.slice(0, 80)}`);
  }

  const sandbox = Object.create(null) as Record<string, unknown>;
  const result: unknown = vm.runInNewContext(trimmed, sandbox, { timeout: 100 });
  if (typeof result !== 'string') {
    throw new ComciParseError('Key expression did not evaluate to a string.');
  }
  return result;
}

function mustMatch(text: string, regex: RegExp, label: string): RegExpMatchArray {
  const match = text.match(regex);
  if (!match) {
    throw new ComciParseError(`Failed to extract ${label} from Comcigan client script.`);
  }
  return match;
}

export function extractFrameSrc(portalHtml: string, portalUrl: string): string | null {
  const frameMatch = portalHtml.match(/<FRAME\s+src=['"]([^'"]+)['"]/i);
  if (!frameMatch) return null;
  return new URL(frameMatch[1], portalUrl).toString();
}

export function extractSessionConfig(
  html: string,
  entryUrl: string,
  cookie: string
): ComciSessionConfig {
  const tokenMatch = mustMatch(
    html,
    /window\.__HourRequestToken\s*=\s*['"]([^'"]+)['"]/,
    '__HourRequestToken'
  );

  const scriptContents = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) =>
    deobfuscateScriptText(m[1])
  );
  const fullJs = scriptContents.join('\n');

  const searchFnMatch = mustMatch(
    fullJs,
    /function\s+\w+\s*\(\s*sc\s*,\s*success\s*\)\s*\{[\s\S]*?s7\s*=\s*['"]([^'"]+)['"]\s*\+\s*encodeURIComponent\(sc\)[\s\S]*?url\s*:\s*['"]([^'"]+)['"][\s\S]*?btoa\(\s*s7\s*\+\s*['"]([^'"]+)['"]\s*\)/,
    'school search AJAX config'
  );

  const ttFnMatch = mustMatch(
    fullJs,
    /function\s+\w+\s*\(\s*sc\s*,\s*sc2\s*,\s*da1\s*,\s*r\s*,\s*success\s*\)\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"][\s\S]*?btoa\(\s*s8\s*\+\s*['"]_['"]\s*\+\s*r\s*\+\s*['"]([^'"]+)['"]\s*\)/,
    'timetable AJAX config'
  );

  const ttPrefixMatch = mustMatch(
    fullJs,
    /\(\s*['"](\d+_)['"]\s*,\s*(?:sc|storage\.sc)\s*,\s*1\s*,\s*['"][01]['"]\s*\)/,
    'timetable route prefix'
  );

  const divisorMatch = fullJs.match(/Math\.floor\(\s*\w+\[i\]\[0\]\s*\/\s*(\d+)\s*\)\s*\+\s*2/);
  const schoolCodeDivisor = divisorMatch ? Number(divisorMatch[1]) : 6347;

  const xorKeyMatch = mustMatch(
    fullJs,
    /function\s+(\w+)\s*\(\s*data\s*\)\s*\{\s*if\s*\(\s*data\s*==\s*undefined[\s\S]*?var\s+a1\s*=\s*([^;]+);\s*var\s+a2\s*=\s*atob\(data\)/,
    'XOR decode key'
  );
  const xorFnName = xorKeyMatch[1];
  const xorKey = evalPureStringExpression(xorKeyMatch[2]);

  const aesKeyMatch = mustMatch(
    fullJs,
    /var\s+key\s*=\s*CryptoJS\.enc\.Hex\.parse\(\s*([\s\S]*?)\s*\)\s*;\s*var\s+tag\s*=/,
    'AES key expression'
  );
  const aesKeyHex = evalPureStringExpression(aesKeyMatch[1]);

  const base64PrefixMatch = fullJs.match(/var\s+useBase64\s*=\s*\(\s*parts\[0\]\s*===\s*['"]([^'"]+)['"]\s*\)/);
  const base64Prefix =
    base64PrefixMatch?.[1] ?? searchFnMatch[3].replace(/^_/, '');

  const fields = extractFieldKeys(fullJs, xorFnName);
  const ajaxUrl = new URL(searchFnMatch[2] || ttFnMatch[1], entryUrl).toString();

  return {
    entryUrl,
    ajaxUrl,
    requestToken: tokenMatch[1],
    cookie,
    searchPrefix: searchFnMatch[1],
    searchSuffix: searchFnMatch[3],
    timetablePrefix: ttPrefixMatch[1],
    timetableSuffix: ttFnMatch[2],
    schoolCodeDivisor,
    xorKey,
    aesKeyHex,
    base64Prefix,
    fields,
    fetchedAt: Date.now(),
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFieldKeys(fullJs: string, xorFnName: string): ComciFieldKeys {
  const escapedXor = escapeRegex(xorFnName);

  const teachersKey = mustMatch(
    fullJs,
    /성명\s*=\s*[$\w가-힣]+\(\s*[$\w가-힣]+\.([A-Za-z0-9_]+)\[th\]\s*\)/,
    'teachersKey'
  )[1];

  const subjectsKey = mustMatch(
    fullJs,
    /과목명\s*=\s*[$\w가-힣]+\(\s*[$\w가-힣]+\.([A-Za-z0-9_]+)\[sb\]\s*\)/,
    'subjectsKey'
  )[1];

  // Resolve original & daily timetable keys via baSplit(dailyVar, origVar, 자료.변경알림)
  // so randomized local variable names and helper function names never break extraction.
  let originalTimetableKey: string | undefined;
  let dailyTimetableKey: string | undefined;

  const baSplitCallMatch = fullJs.match(
    /baSplit\(\s*([$\w가-힣]+)\s*,\s*([$\w가-힣]+)\s*,\s*[$\w가-힣]+\.변경알림\s*\)/
  );
  if (baSplitCallMatch) {
    const [, dailyVar, origVar] = baSplitCallMatch;
    const origAssign = fullJs.match(
      new RegExp(
        `${escapeRegex(origVar)}\\s*=\\s*[\\$\\w가-힣]+\\(\\s*[\\$\\w가-힣]+\\.([A-Za-z0-9_]+)\\[학년\\]\\[반\\]\\[요일\\]\\[교시\\]\\s*\\)`
      )
    );
    const dailyAssign = fullJs.match(
      new RegExp(
        `${escapeRegex(dailyVar)}\\s*=\\s*[\\$\\w가-힣]+\\(\\s*[\\$\\w가-힣]+\\.([A-Za-z0-9_]+)\\[학년\\]\\[반\\]\\[요일\\]\\[교시\\]\\s*\\)`
      )
    );
    originalTimetableKey = origAssign?.[1];
    dailyTimetableKey = dailyAssign?.[1];
  }

  if (!originalTimetableKey || !dailyTimetableKey) {
    const pairMatch = mustMatch(
      fullJs,
      /[$\w가-힣]+\s*=\s*[$\w가-힣]+\(\s*[$\w가-힣]+\.([A-Za-z0-9_]+)\[학년\]\[반\]\[요일\]\[교시\]\s*\)\s*;\s*[$\w가-힣]+\s*=\s*[$\w가-힣]+\(\s*[$\w가-힣]+\.([A-Za-z0-9_]+)\[학년\]\[반\]\[요일\]\[교시\]\s*\)/,
      'original/daily timetable keys'
    );
    originalTimetableKey = originalTimetableKey ?? pairMatch[1];
    dailyTimetableKey = dailyTimetableKey ?? pairMatch[2];
  }

  const classroomKey = mustMatch(
    fullJs,
    /var\s+m3\s*=\s*[$\w가-힣]+\.([A-Za-z0-9_]+)\[학년\]\[반\]\[요일\]\[교시\]/,
    'classroomKey'
  )[1];

  const modifiedAtKey = mustMatch(
    fullJs,
    new RegExp(
      `\\$\\('#수정일'\\)\\.text\\(\\s*'수정일:\\s*'\\s*\\+\\s*${escapedXor}\\(\\s*[$\\w가-힣]+\\.([A-Za-z0-9_]+)\\s*\\)\\s*\\)`
    ),
    'modifiedAtKey'
  )[1];

  const startDateKey = mustMatch(
    fullJs,
    new RegExp(`요일출력하기\\(\\s*${escapedXor}\\(\\s*[$\\w가-힣]+\\.([A-Za-z0-9_]+)\\s*\\)\\s*\\)`),
    'startDateKey'
  )[1];

  const periodsKey = mustMatch(
    fullJs,
    /[$\w가-힣]+\.([A-Za-z0-9_]+)\[교시-1\]/,
    'periodsKey'
  )[1];

  const datesKey = mustMatch(
    fullJs,
    /일자설정하기\(\s*[$\w가-힣]+\.([A-Za-z0-9_]+)\s*,\s*r2\s*\)/,
    'datesKey'
  )[1];

  return {
    teachersKey,
    subjectsKey,
    originalTimetableKey,
    dailyTimetableKey,
    classroomKey,
    modifiedAtKey,
    startDateKey,
    periodsKey,
    datesKey,
  };
}
