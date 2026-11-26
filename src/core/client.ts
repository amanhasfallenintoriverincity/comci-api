import { decryptComciPayload } from './crypto.js';
import { extractFrameSrc, extractSessionConfig } from './deobfuscator.js';
import {
  ComciApiError,
  ComciNotFoundError,
  ComciParseError,
  ComciRateLimitError,
  ComciServiceBusyError,
  ComciTokenError,
  ComciValidationError,
} from './errors.js';
import {
  extractSchoolMeta,
  parseClassTimetable,
  parseSchoolSearchResult,
  type RawTimetablePayload,
} from './parser.js';
import type {
  ClassTimetable,
  ComciClientOptions,
  ComciSessionConfig,
  SchoolMeta,
  SchoolSearchItem,
} from './types.js';

const DEFAULT_ENTRY_URL = 'http://comci.net:4082/st';
const DEFAULT_PORTAL_URL = 'http://www.xn--s39aj90b0nb2xw6xh.kr/';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ComciClient {
  private readonly entryUrl: string;
  private readonly portalUrl: string;
  private readonly sessionTtlMs: number;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly userAgent: string;

  private session: ComciSessionConfig | null = null;
  private sessionPromise: Promise<ComciSessionConfig> | null = null;
  private readonly responseCache = new Map<string, CacheEntry<unknown>>();
  private readonly schoolNameCache = new Map<number, string>();

  constructor(options: ComciClientOptions = {}) {
    this.entryUrl = options.entryUrl ?? DEFAULT_ENTRY_URL;
    this.portalUrl = options.portalUrl ?? DEFAULT_PORTAL_URL;
    this.sessionTtlMs = options.sessionTtlMs ?? 10 * 60 * 1000;
    this.cacheTtlMs = options.cacheTtlMs ?? 60 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  public clearCache(): void {
    this.responseCache.clear();
  }

  public invalidateSession(): void {
    this.session = null;
  }

  public async getSession(forceRefresh = false): Promise<ComciSessionConfig> {
    if (!forceRefresh && this.session && Date.now() - this.session.fetchedAt < this.sessionTtlMs) {
      return this.session;
    }
    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    this.sessionPromise = this.fetchNewSession().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  private async fetchNewSession(): Promise<ComciSessionConfig> {
    let targetUrl = this.entryUrl;
    let res: Response;
    try {
      res = await this.fetchWithTimeout(targetUrl, {
        headers: { 'User-Agent': this.userAgent },
      });
    } catch (err) {
      // Fallback: resolve entry frame URL from portal domain
      const portalRes = await this.fetchWithTimeout(this.portalUrl, {
        headers: { 'User-Agent': this.userAgent },
      });
      const portalHtml = new TextDecoder('euc-kr').decode(new Uint8Array(await portalRes.arrayBuffer()));
      const frameSrc = extractFrameSrc(portalHtml, this.portalUrl);
      if (!frameSrc) throw err;
      targetUrl = frameSrc;
      res = await this.fetchWithTimeout(targetUrl, {
        headers: { 'User-Agent': this.userAgent },
      });
    }

    if (!res.ok) {
      throw new ComciApiError(`Failed to load Comcigan entry page (${res.status})`, 'UPSTREAM_HTTP', res.status);
    }

    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    const buf = new Uint8Array(await res.arrayBuffer());
    const html = new TextDecoder('euc-kr').decode(buf);

    const config = extractSessionConfig(html, targetUrl, cookie);
    this.session = config;
    return config;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private getCached<T>(key: string): T | null {
    if (this.cacheTtlMs <= 0) return null;
    const entry = this.responseCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.responseCache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private setCached<T>(key: string, value: T): void {
    if (this.cacheTtlMs <= 0) return;
    if (this.responseCache.size >= 200) {
      const oldestKey = this.responseCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.responseCache.delete(oldestKey);
      }
    }
    this.responseCache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  private async postAjax(
    session: ComciSessionConfig,
    body: string
  ): Promise<string> {
    const res = await this.fetchWithTimeout(session.ajaxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        'X-Hour-Token': session.requestToken,
        'User-Agent': this.userAgent,
        Referer: session.entryUrl,
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      },
      body,
    });

    const text = (await res.text()).replace(/\0+$/, '');

    if (res.status === 403 && text === 'HOUR_TOKEN_REQUIRED') {
      throw new ComciTokenError();
    }
    if (res.status === 429 && text === 'HOUR_RATE_LIMIT') {
      throw new ComciRateLimitError();
    }
    if (res.status === 503 && text === 'HOUR_SERVICE_BUSY') {
      throw new ComciServiceBusyError();
    }
    if (!res.ok) {
      throw new ComciApiError(
        `Comcigan AJAX error (${res.status}): ${text.slice(0, 120)}`,
        'UPSTREAM_HTTP',
        res.status
      );
    }

    return decryptComciPayload(text, session.aesKeyHex, session.base64Prefix);
  }

  private async executeWithSessionRetry<T>(
    fn: (session: ComciSessionConfig) => Promise<T>
  ): Promise<{ result: T; session: ComciSessionConfig }> {
    let session = await this.getSession();
    try {
      const result = await fn(session);
      return { result, session };
    } catch (err) {
      if (err instanceof ComciTokenError || err instanceof ComciParseError) {
        this.invalidateSession();
        session = await this.getSession(true);
        const result = await fn(session);
        return { result, session };
      }
      throw err;
    }
  }

  public async searchSchools(query: string): Promise<SchoolSearchItem[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new ComciValidationError('검색할 학교명을 입력해 주세요.');
    }

    const cacheKey = `search:${trimmed}`;
    const cached = this.getCached<SchoolSearchItem[]>(cacheKey);
    if (cached) return cached;

    const { result } = await this.executeWithSessionRetry(async (session) => {
      const rawParam = `${session.searchPrefix}${encodeURIComponent(trimmed)}${session.searchSuffix}`;
      const body = encodeURIComponent(Buffer.from(rawParam, 'utf8').toString('base64'));
      const decrypted = await this.postAjax(session, body);
      const json = JSON.parse(decrypted) as unknown;
      return parseSchoolSearchResult(json, session);
    });

    for (const item of result) {
      this.schoolNameCache.set(item.code, item.name);
    }
    this.setCached(cacheKey, result);
    return result;
  }

  public async getRawTimetable(
    schoolCode: number,
    weekIndex = 1
  ): Promise<{ payload: RawTimetablePayload; session: ComciSessionConfig }> {
    if (!Number.isInteger(schoolCode) || schoolCode <= 0) {
      throw new ComciValidationError(`유효한 학교 코드가 아닙니다. (입력: ${schoolCode})`);
    }
    if (!Number.isInteger(weekIndex) || weekIndex < 1) {
      throw new ComciValidationError(`주차 인덱스(week)는 1 이상의 정수여야 합니다. (입력: ${weekIndex})`);
    }

    const cacheKey = `tt:${schoolCode}:${weekIndex}`;
    const cached = this.getCached<RawTimetablePayload>(cacheKey);
    if (cached) {
      const session = await this.getSession();
      return { payload: cached, session };
    }

    const { result: payload, session } = await this.executeWithSessionRetry(async (sess) => {
      const rawParam = `${sess.timetablePrefix}${schoolCode}_0_${weekIndex}${sess.timetableSuffix}`;
      const body = Buffer.from(rawParam, 'utf8').toString('base64');
      const decrypted = await this.postAjax(sess, body);
      const lastBrace = decrypted.lastIndexOf('}');
      if (lastBrace < 0) {
        throw new ComciNotFoundError(`학교 코드 ${schoolCode}의 시간표 데이터를 찾을 수 없습니다.`);
      }
      const jsonStr = decrypted.slice(0, lastBrace + 1);
      const parsed = JSON.parse(jsonStr) as RawTimetablePayload;
      if (!parsed || Object.keys(parsed).length === 0 || !parsed['학급수']) {
        throw new ComciNotFoundError(`학교 코드 ${schoolCode}의 시간표 데이터가 비어 있습니다.`);
      }
      return parsed;
    });

    this.setCached(cacheKey, payload);
    return { payload, session };
  }

  public async getSchoolMeta(
    schoolCode: number,
    weekIndex = 1,
    schoolNameOverride?: string
  ): Promise<SchoolMeta> {
    const { payload, session } = await this.getRawTimetable(schoolCode, weekIndex);
    const resolvedName = schoolNameOverride ?? this.schoolNameCache.get(schoolCode);
    return extractSchoolMeta(payload, session, schoolCode, weekIndex, resolvedName);
  }

  public async getClassTimetable(
    schoolCode: number,
    grade: number,
    classNumber: number,
    weekIndex = 1,
    schoolNameOverride?: string
  ): Promise<ClassTimetable> {
    const { payload, session } = await this.getRawTimetable(schoolCode, weekIndex);
    const resolvedName = schoolNameOverride ?? this.schoolNameCache.get(schoolCode);
    return parseClassTimetable(
      payload,
      session,
      schoolCode,
      grade,
      classNumber,
      weekIndex,
      resolvedName
    );
  }

  public async findAndGetClassTimetable(
    schoolQuery: string,
    grade: number,
    classNumber: number,
    weekIndex = 1
  ): Promise<{ school: SchoolSearchItem; timetable: ClassTimetable }> {
    const schools = await this.searchSchools(schoolQuery);
    if (schools.length === 0) {
      throw new ComciNotFoundError(`'${schoolQuery}'에 해당하는 학교를 찾을 수 없습니다.`);
    }
    const exactMatch = schools.find((s) => s.name === schoolQuery.trim()) ?? schools[0];
    const timetable = await this.getClassTimetable(
      exactMatch.code,
      grade,
      classNumber,
      weekIndex,
      exactMatch.name
    );
    return { school: exactMatch, timetable };
  }
}
