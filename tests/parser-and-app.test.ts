import { describe, expect, it, vi } from 'vitest';
import { ComciClient } from '../src/core/client.js';
import { ComciRateLimitError } from '../src/core/errors.js';
import { parseClassTimetable, parseSchoolSearchResult } from '../src/core/parser.js';
import type { ComciSessionConfig } from '../src/core/types.js';
import { createApp } from '../src/server/app.js';

function encodeXorAscii(str: string, key: string): string {
  const bytes = Buffer.from(str, 'ascii');
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ key.charCodeAt(i % key.length);
  }
  return out.toString('base64');
}

const mockSession: ComciSessionConfig = {
  entryUrl: 'http://comci.net:4082/st',
  ajaxUrl: 'http://comci.net:4082/959975',
  requestToken: 'tok',
  cookie: 'c=1',
  searchPrefix: '15565l',
  searchSuffix: '_8701',
  timetablePrefix: '40826_',
  timetableSuffix: '_8701',
  schoolCodeDivisor: 6347,
  xorKey: 'KEY123',
  aesKeyHex: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  base64Prefix: '8701',
  fields: {
    teachersKey: 'LXL324',
    subjectsKey: 'PGD146',
    originalTimetableKey: 'ZSH114',
    dailyTimetableKey: 'DIT367',
    classroomKey: 'KLA521',
    modifiedAtKey: 'DNW740',
    startDateKey: 'VXC229',
    periodsKey: 'OCO191',
    datesKey: 'XSE164',
  },
  fetchedAt: Date.now(),
};

describe('parser', () => {
  it('parses school search rows and ignores message rows', () => {
    const json = {
      학교검색: [
        [0, encodeXorAscii('info', 'KEY123'), encodeXorAscii('msg', 'KEY123')],
        [
          12694, // Math.floor(12694/6347)+2 = 4
          encodeXorAscii('Seoul', 'KEY123'),
          encodeXorAscii('TestHigh', 'KEY123'),
          encodeXorAscii('111', 'KEY123'),
          encodeXorAscii('76524', 'KEY123'),
          encodeXorAscii('222', 'KEY123'),
        ],
      ],
    };

    const schools = parseSchoolSearchResult(json, mockSession);
    expect(schools).toEqual([
      { code: 76524, name: 'TestHigh', region: 'Seoul', rawId: 12694 },
    ]);
  });

  it('parses timetable cells, changed periods, cancelled periods, split groups, and classrooms', () => {
    const k = mockSession.xorKey;
    // Period 1: unchanged Math by Kim in room 302_Lab
    // Period 2: changed from Physics/Lee to Chemistry/Park (with '>' prefix)
    // Period 3: split group B (subject index 2003 with 분리=1000 -> group B, subject 3)
    // Period 4: cancelled period (maxPeriod=3, normalMaxPeriod=4 -> empty & isChanged=true)
    const emptyDay = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const emptyRooms = ['', '', '', '', '', '', '', '', ''];

    const payload = {
      학급수: [3, 1, 1, 1],
      가상학급수: [0, 0, 0, 0],
      학년도: 2026,
      학기시작일자: '2026-08-01',
      학교명: encodeXorAscii('DemoSchool', k),
      지역명: encodeXorAscii('Seoul', k),
      DNW740: encodeXorAscii('2026-11-25 09:00:00', k),
      VXC229: encodeXorAscii('2026-11-23', k),
      XSE164: [[1, encodeXorAscii('26-11-23 ~ 26-11-28', k)]],
      OCO191: ['1(08:30)', '2(09:30)', '3(10:30)', '4(11:30)', '5', '6', '7', '8'],
      오늘r: 1,
      분리: 1000,
      변경알림: 1,
      강의실: 1,
      열람제한일: '1899-12-30',
      요일별시수: [[], [0, 4, 0, 0, 0, 0, 0]],
      LXL324: ['', encodeXorAscii('Kim*', k), encodeXorAscii('Lee*', k), encodeXorAscii('Park*', k)],
      PGD146: ['', encodeXorAscii('Math', k), encodeXorAscii('Phys', k), encodeXorAscii('Chem', k)],
      ZSH114: [
        [],
        [
          [],
          [
            [],
            [4, 1001, 2002, 2003003, 1001, 0, 0, 0, 0],
            emptyDay,
            emptyDay,
            emptyDay,
            emptyDay,
          ],
        ],
      ],
      DIT367: [
        [],
        [
          [],
          [
            [],
            [3, 1001, '>3003', 2003003, 0, 0, 0, 0, 0],
            emptyDay,
            emptyDay,
            emptyDay,
            emptyDay,
          ],
        ],
      ],
      KLA521: [
        [],
        [
          [],
          [
            [],
            ['', '302_MathLab', '', '', '', '', '', '', ''],
            emptyRooms,
            emptyRooms,
            emptyRooms,
            emptyRooms,
          ],
        ],
      ],
    };

    const tt = parseClassTimetable(payload, mockSession, 76524, 1, 1, 1, 'RealHigh');
    expect(tt.schoolName).toBe('RealHigh');
    expect(tt.payloadSchoolName).toBe('DemoSchool');
    expect(tt.days).toHaveLength(5);

    const mon = tt.days[0];
    expect(mon.weekdayName).toBe('월');
    expect(mon.date).toBe('2026-11-23');

    expect(mon.periods[0]).toMatchObject({
      period: 1,
      subject: 'Math',
      teacher: 'Kim',
      classroom: 'MathLab',
      classroomCode: 302,
      isChanged: false,
      isEmpty: false,
    });

    expect(mon.periods[1]).toMatchObject({
      period: 2,
      subject: 'Chem',
      teacher: 'Park',
      isChanged: true,
      original: { subject: 'Phys', subjectCode: 2, teacher: 'Lee', teacherCode: 2 },
    });

    expect(mon.periods[2]).toMatchObject({
      period: 3,
      subject: 'Chem',
      groupCode: 'B',
      displaySubject: 'B_Chem',
      teacher: 'Park',
    });

    expect(mon.periods[3]).toMatchObject({
      period: 4,
      isEmpty: true,
      isChanged: true,
      original: { subject: 'Math', subjectCode: 1, teacher: 'Kim', teacherCode: 1 },
    });
  });
});

describe('Hono REST API app', () => {
  it('validates queries and forwards ComciApiError status codes', async () => {
    const fakeClient = {
      searchSchools: vi.fn().mockResolvedValue([{ code: 76524, name: '경기고등학교', region: '서울', rawId: 1 }]),
      getSchoolMeta: vi.fn().mockRejectedValue(new ComciRateLimitError()),
      getClassTimetable: vi.fn(),
      findAndGetClassTimetable: vi.fn(),
    } as unknown as ComciClient;

    const app = createApp({ client: fakeClient });

    const healthRes = await app.request('/health');
    expect(healthRes.status).toBe(200);

    const badSearchRes = await app.request('/api/schools');
    expect(badSearchRes.status).toBe(400);

    const okSearchRes = await app.request('/api/schools?q=%EA%B2%BD%EA%B8%B0');
    expect(okSearchRes.status).toBe(200);
    expect(await okSearchRes.json()).toMatchObject({
      success: true,
      count: 1,
    });

    const rateLimitRes = await app.request('/api/schools/76524/meta');
    expect(rateLimitRes.status).toBe(429);
    expect(await rateLimitRes.json()).toMatchObject({
      success: false,
      error: { code: 'HOUR_RATE_LIMIT' },
    });
  });
});
