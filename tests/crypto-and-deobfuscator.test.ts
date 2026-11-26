import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptComciPayload, decodeXorEucKr, formatTeacherName } from '../src/core/crypto.js';
import {
  deobfuscateScriptText,
  evalPureStringExpression,
  extractFrameSrc,
  extractSessionConfig,
} from '../src/core/deobfuscator.js';

function encodeXorAscii(str: string, key: string): string {
  const bytes = Buffer.from(str, 'ascii');
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ key.charCodeAt(i % key.length);
  }
  return out.toString('base64');
}

function encodeObfuscatedBlock(js: string, key: number): string {
  let hex = '';
  for (let i = 0; i < js.length; i++) {
    const code = js.charCodeAt(i) ^ ((key + i * 13) & 255);
    hex += code.toString(16).padStart(4, '0');
  }
  return `/* hour-obfuscated-v2 */(function(a,k){var s='',i,j,b;for(i=0;i<a.length;i++){if(a[i][0]){s+=a[i][1];continue;}b=a[i][1];for(j=0;j<b.length;j+=4){s+=String.fromCharCode(parseInt(b.substr(j,4),16)^((k+(j/4)*13)&255));}}(0,eval)(s);})([[0,"${hex}"]],${key});`;
}

describe('crypto utilities', () => {
  it('decrypts 8701 base64 AES-256-CBC + HMAC-SHA256 payloads', () => {
    const keyHex = 'a8f019b9429ea526cd0411ec184a7ef59f0f8ec0cd9db21809c48177e8f64577';
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const plaintext = JSON.stringify({ hello: '컴시간' });
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    const header = `8701:${iv.toString('base64')}:${ct.toString('base64')}`;
    const hmacKey = crypto.createHash('sha256').update(key).digest();
    const tag = crypto.createHmac('sha256', hmacKey).update(header).digest('base64');

    const result = decryptComciPayload(`${header}:${tag}\0\0`, keyHex);
    expect(JSON.parse(result)).toEqual({ hello: '컴시간' });
  });

  it('throws on tampered HMAC tag', () => {
    const keyHex = 'a8f019b9429ea526cd0411ec184a7ef59f0f8ec0cd9db21809c48177e8f64577';
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const ct = Buffer.concat([cipher.update('test', 'utf8'), cipher.final()]);
    const badTag = Buffer.alloc(32, 0xaa).toString('base64');

    expect(() =>
      decryptComciPayload(`8701:${iv.toString('base64')}:${ct.toString('base64')}:${badTag}`, keyHex)
    ).toThrow(/HMAC/);
  });

  it('decodes XOR+EUC-KR and teacher asterisk formatting', () => {
    const xorKey = 'z7lSivYC3-[<';
    const enc = encodeXorAscii('2026-11-23', xorKey);
    expect(decodeXorEucKr(enc, xorKey)).toBe('2026-11-23');

    expect(formatTeacherName(encodeXorAscii('Kim*', xorKey), xorKey)).toBe('Kim');
    expect(formatTeacherName(encodeXorAscii('K*', xorKey), xorKey)).toBe('K*');
    expect(formatTeacherName(encodeXorAscii('K*m', xorKey), xorKey)).toBe('K*m');
  });
});

describe('deobfuscator & config extractor', () => {
  it('decodes nested obfuscated blocks', () => {
    const inner = encodeObfuscatedBlock("var x='ok';", 83);
    const outer = encodeObfuscatedBlock(inner + "var y='yes';", 100);
    expect(deobfuscateScriptText(outer)).toBe("var x='ok';var y='yes';");
  });

  it('blocks unsafe expressions in evalPureStringExpression', () => {
    expect(() => evalPureStringExpression('process.exit(1)')).toThrow(/Unsafe/);
    expect(evalPureStringExpression('String.fromCharCode(65,66)')).toBe('AB');
  });

  it('extracts frame src from portal HTML', () => {
    const html = `<FRAMESET ROWS="100%,*"><FRAME src='http://comci.net:4082/st'></FRAMESET>`;
    expect(extractFrameSrc(html, 'http://www.xn--s39aj90b0nb2xw6xh.kr/')).toBe(
      'http://comci.net:4082/st'
    );
  });

  it('extracts dynamic keys and endpoints from obfuscated /st HTML', () => {
    const js = `
      function fnSearch(sc, success) {var s7='15565l'+encodeURIComponent(sc); return $.ajax({ url:'./959975', method:'POST', data:encodeURIComponent(btoa(s7+'_8701')) });}
      function fnTt(sc, sc2, da1, r, success) {var s7=sc+sc2,s8=s7+'_'+da1; return $.ajax({ url:'./959975', method:'POST', data:btoa(s8+'_'+r+'_8701') });}
      function K0eiLN(data) {if(data==undefined||data==='')return '';var a1=String.fromCharCode(65,66,67);var a2=atob(data);return a2;}
      function F5tb25(data) {var key=CryptoJS.enc.Hex.parse('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');var tag=1;}
      function JEI599(자료,학년,반) {
        자료.OCO191[교시-1];
        요일출력하기(K0eiLN(자료.VXC229));
        원자료=Q자료(자료.ZSH114[학년][반][요일][교시]);
        일일자료=Q자료(자료.DIT367[학년][반][요일][교시]);
        var m3=자료.KLA521[학년][반][요일][교시];
        성명=Hg6GVP(자료.LXL324[th]);
        과목명=BIGW1o(자료.PGD146[sb]);
      }
      function 화면구성하기(r) {
        일자설정하기(H시간표.XSE164,r2);
        $('#수정일').text('수정일: '+K0eiLN(H시간표.DNW740));
      }
      function sc_disp(sc) {
        var r=Math.floor(data[i][0]/6347)+2;
        f856wT('40826_',sc,1,'0');
      }
    `;
    const html = `
      <script>window.__HourRequestToken='TEST_TOKEN_123';</script>
      <script>${encodeObfuscatedBlock(js, 42)}</script>
    `;

    const cfg = extractSessionConfig(html, 'http://comci.net:4082/st', 'HourSession=abc');
    expect(cfg.requestToken).toBe('TEST_TOKEN_123');
    expect(cfg.ajaxUrl).toBe('http://comci.net:4082/959975');
    expect(cfg.searchPrefix).toBe('15565l');
    expect(cfg.searchSuffix).toBe('_8701');
    expect(cfg.timetablePrefix).toBe('40826_');
    expect(cfg.timetableSuffix).toBe('_8701');
    expect(cfg.xorKey).toBe('ABC');
    expect(cfg.aesKeyHex).toBe('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
    expect(cfg.fields).toEqual({
      teachersKey: 'LXL324',
      subjectsKey: 'PGD146',
      originalTimetableKey: 'ZSH114',
      dailyTimetableKey: 'DIT367',
      classroomKey: 'KLA521',
      modifiedAtKey: 'DNW740',
      startDateKey: 'VXC229',
      periodsKey: 'OCO191',
      datesKey: 'XSE164',
    });
    expect(cfg.base64Prefix).toBe('8701');
  });

  it('handles randomized local/global variable names and rotating numeric base64 prefix', () => {
    const js = `
      function sMw3(sc, success) {var s7='15604l'+encodeURIComponent(sc); return $.ajax({ url:'./723392', method:'POST', data:encodeURIComponent(btoa(s7+'_3901')) });}
      function q1ci(sc, sc2, da1, r, success) {var s7=sc+sc2,s8=s7+'_'+da1; return $.ajax({ url:'./723392', method:'POST', data:btoa(s8+'_'+r+'_3901') });}
      function ILd5(data) {if(data==undefined||data==='')return '';var a1=String.fromCharCode(65,66,67);var a2=atob(data);return a2;}
      function X8kq(data) {var useBase64=(parts[0]==='3901');var key=CryptoJS.enc.Hex.parse('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');var tag=1;}
      function HEO246(자료,학년,반) {
        자료.JVN282[교시-1];
        요일출력하기(ILd5(자료.BKL275));
        kY7l=K8T6(자료.OXN369[학년][반][요일][교시]);
        z6r2=K8T6(자료.LSC126[학년][반][요일][교시]);
        var m3=자료.ETP565[학년][반][요일][교시];
        var ma=baSplit(z6r2,kY7l,자료.변경알림);
        성명=Gh10(자료.CMO684[th]);
        과목명=Zwf0(자료.TIV461[sb]);
      }
      function 화면구성하기(r) {
        일자설정하기(a50i.RUL153,r2);
        $('#수정일').text('수정일: '+ILd5(a50i.ZWT390));
      }
      function sc_disp(sc) {
        var r=Math.floor(data[i][0]/6347)+2;
        UC9h('38583_',sc,1,'0');
      }
    `;
    const html = `
      <script>window.__HourRequestToken='ROTATED_TOKEN';</script>
      <script>${encodeObfuscatedBlock(js, 77)}</script>
    `;

    const cfg = extractSessionConfig(html, 'http://comci.net:4082/st', 'HourSession=xyz');
    expect(cfg.base64Prefix).toBe('3901');
    expect(cfg.ajaxUrl).toBe('http://comci.net:4082/723392');
    expect(cfg.fields).toEqual({
      teachersKey: 'CMO684',
      subjectsKey: 'TIV461',
      originalTimetableKey: 'OXN369',
      dailyTimetableKey: 'LSC126',
      classroomKey: 'ETP565',
      modifiedAtKey: 'ZWT390',
      startDateKey: 'BKL275',
      periodsKey: 'JVN282',
      datesKey: 'RUL153',
    });
  });
});
