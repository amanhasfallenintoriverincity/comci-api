import { decodeXorEucKr, formatTeacherName } from './crypto.js';
import { ComciParseError, ComciValidationError } from './errors.js';
import type {
  AvailableWeek,
  ClassTimetable,
  ComciSessionConfig,
  OriginalPeriodInfo,
  SchoolMeta,
  SchoolSearchItem,
  TimetableDay,
  TimetablePeriod,
  WeekdayName,
  WeekdayNumber,
} from './types.js';

export type RawTimetablePayload = Record<string, unknown>;

interface RawSchoolSearchPayload {
  학교검색?: Array<[number, string, string, ...string[]]>;
}

const WEEKDAY_NAMES: Record<WeekdayNumber, WeekdayName> = {
  1: '월',
  2: '화',
  3: '수',
  4: '목',
  5: '금',
};

export function parseSchoolSearchResult(
  json: unknown,
  session: ComciSessionConfig
): SchoolSearchItem[] {
  const payload = json as RawSchoolSearchPayload;
  if (!payload || !Array.isArray(payload.학교검색)) {
    throw new ComciParseError('Invalid school search response structure.');
  }

  const results: SchoolSearchItem[] = [];
  for (const row of payload.학교검색) {
    if (!Array.isArray(row) || row[0] === 0) {
      continue;
    }
    const rawId = Number(row[0]);
    const region = decodeXorEucKr(row[1], session.xorKey);
    const name = decodeXorEucKr(row[2], session.xorKey);
    const codeCol = Math.floor(rawId / session.schoolCodeDivisor) + 2;
    const encodedCode = row[codeCol];
    const code = Number(
      decodeXorEucKr(typeof encodedCode === 'string' ? encodedCode : undefined, session.xorKey)
    );
    if (!Number.isFinite(code) || code <= 0) {
      continue;
    }
    results.push({ code, name, region, rawId });
  }
  return results;
}

export function splitCellNumber(dat: string | number): number[] {
  const matches = String(dat).match(/\d{1,3}(?=(\d{3})+(?!\d))|\d{1,3}$/g);
  if (!matches) return [0];
  return matches.reverse().map(Number);
}

export function splitCellPair(
  dailyRaw: string | number | undefined,
  originalRaw: string | number | undefined,
  changeNoticeFlag: number
): { teacherIdx: number; subjectIdx: number; isChanged: boolean } {
  const dailyVal = dailyRaw ?? 0;
  const origVal = originalRaw ?? 0;

  let parts: number[];
  let isChanged: boolean;

  if (changeNoticeFlag === 1) {
    const dailyStr = String(dailyVal);
    if (dailyStr.startsWith('>')) {
      parts = splitCellNumber(dailyStr.slice(1));
      isChanged = true;
    } else {
      parts = splitCellNumber(dailyVal);
      isChanged = false;
    }
  } else {
    parts = splitCellNumber(dailyVal);
    isChanged = origVal !== dailyVal;
  }

  const teacherIdx = parts[0] ?? 0;
  const subjectIdx = (parts[1] ?? 0) + Number(parts[2] ?? 0) * 1000;
  return { teacherIdx, subjectIdx, isChanged };
}

function getGroupPrefixFromSplit(subjectRawIdx: number, splitDivisor: number): string | null {
  if (splitDivisor === 100) return null;
  const t = Math.floor(subjectRawIdx / splitDivisor);
  if (t >= 1 && t <= 26) {
    return String.fromCharCode(t + 64);
  }
  return null;
}

function parseMaValue(ma: unknown): number {
  if (ma === null || ma === undefined) return 0;
  const str = String(ma);
  const target = str.startsWith('>') ? str.slice(1) : str;
  return Number(target) || 0;
}

function computeSimultaneousGroupCode(
  payload: RawTimetablePayload,
  dailyKey: string,
  grade: number,
  classNumber: number,
  subjectIdx: number,
  weekday: number,
  period: number
): string | null {
  const groups = payload['동시그룹'];
  const dailyArr = payload[dailyKey] as unknown[][][][] | undefined;
  if (!Array.isArray(groups) || !Array.isArray(dailyArr) || groups.length === 0) {
    return null;
  }

  const groupCount = Number((groups[0] as unknown[])?.[0] ?? 0);
  for (let k = 1; k <= 2; k++) {
    for (let i = 1; i <= groupCount; i++) {
      const groupRow = groups[i] as number[] | undefined;
      if (!Array.isArray(groupRow)) continue;

      let n1 = 0;
      let n2 = 0;
      let targetGroup = 0;
      let aborted = false;

      const memberCount = Number(groupRow[0] ?? 0);
      for (let j = 1; j <= memberCount; j++) {
        const entry: number = Number(groupRow[j] ?? 0);
        const sb4: number = Math.floor(entry / 1000);
        const grp2: number = Math.floor(sb4 / 1000);
        const sb2: number = sb4 - grp2 * 1000;
        const teacher: number = Math.floor(grp2 / 100);
        const grp: number = grp2 - teacher * 100;
        const cls: number = entry - sb4 * 1000;
        const grade2: number = Math.floor(cls / 100);
        const class2: number = cls - grade2 * 100;

        if (grade === grade2 && classNumber === class2 && subjectIdx === sb2) {
          targetGroup = grp;
        }

        const m3 = parseMaValue(dailyArr?.[grade2]?.[class2]?.[weekday]?.[period]);
        const sb3 = Math.floor(m3 / 1000);
        const teacher2 = m3 - sb3 * 1000;

        if (grade === grade2 && sb3 === sb2 && teacher === teacher2) {
          n1 += 1;
        } else if (grade === grade2 && sb3 === sb2) {
          n2 += 1;
        } else {
          aborted = true;
          break;
        }
      }

      if (aborted || targetGroup === 0) continue;
      const m2 = n1 + n2;
      if ((k === 1 && n1 === memberCount) || (k === 2 && m2 === memberCount)) {
        return String.fromCharCode(targetGroup + 64);
      }
    }
  }

  return null;
}

function parseClassroom(
  payload: RawTimetablePayload,
  classroomKey: string,
  grade: number,
  classNumber: number,
  weekday: number,
  period: number
): { classroom: string | null; classroomCode: number | null } {
  if (Number(payload['강의실'] ?? 0) !== 1) {
    return { classroom: null, classroomCode: null };
  }
  const roomArr = payload[classroomKey] as unknown[][][][] | undefined;
  const raw = roomArr?.[grade]?.[classNumber]?.[weekday]?.[period];
  if (typeof raw !== 'string') {
    return { classroom: null, classroomCode: null };
  }
  const underscoreIdx = raw.indexOf('_');
  if (underscoreIdx <= 0) {
    return { classroom: null, classroomCode: null };
  }
  const code = Number(raw.slice(0, underscoreIdx));
  const roomName = raw.slice(underscoreIdx + 1);
  if (code > 0 && roomName) {
    return { classroom: roomName, classroomCode: code };
  }
  return { classroom: null, classroomCode: null };
}

function addDaysIso(dateIso: string, deltaDays: number): string {
  const parts = dateIso.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return dateIso;
  }
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function isDateRestricted(dateIso: string, restrictionRaw: unknown): boolean {
  if (typeof restrictionRaw !== 'string' || !restrictionRaw) return false;
  const restriction = new Date(restrictionRaw);
  if (Number.isNaN(restriction.getTime()) || restriction.getUTCFullYear() < 2014) {
    return false;
  }
  const dt = new Date(dateIso);
  if (Number.isNaN(dt.getTime())) return false;
  return dt >= restriction;
}

export function extractSchoolMeta(
  payload: RawTimetablePayload,
  session: ComciSessionConfig,
  schoolCode: number,
  weekIndex: number,
  schoolNameOverride?: string
): SchoolMeta {
  const { fields } = session;
  const classCountsArr = (payload['학급수'] as number[] | undefined) ?? [0, 0, 0, 0];
  const virtualCountsArr = (payload['가상학급수'] as number[] | undefined) ?? [0, 0, 0, 0];

  const rawWeeks = (payload[fields.datesKey] as Array<[number, string]> | undefined) ?? [];
  const availableWeeks: AvailableWeek[] = rawWeeks.map(([idx, encLabel]) => ({
    index: Number(idx),
    label: decodeXorEucKr(encLabel, session.xorKey),
  }));

  const payloadSchoolName = decodeXorEucKr(payload['학교명'] as string | undefined, session.xorKey);
  const region = decodeXorEucKr(payload['지역명'] as string | undefined, session.xorKey);
  const modifiedAt = decodeXorEucKr(payload[fields.modifiedAtKey] as string | undefined, session.xorKey);
  const weekStartDate = decodeXorEucKr(payload[fields.startDateKey] as string | undefined, session.xorKey);
  const periodLabels = ((payload[fields.periodsKey] as string[] | undefined) ?? []).map(String);

  return {
    schoolCode,
    schoolName: schoolNameOverride || payloadSchoolName,
    payloadSchoolName,
    region,
    academicYear: Number(payload['학년도'] ?? 0),
    semesterStartDate: String(payload['학기시작일자'] ?? ''),
    modifiedAt,
    weekIndex,
    todayWeekIndex: Number(payload['오늘r'] ?? weekIndex),
    weekStartDate,
    availableWeeks,
    classCounts: {
      1: Number(classCountsArr[1] ?? 0),
      2: Number(classCountsArr[2] ?? 0),
      3: Number(classCountsArr[3] ?? 0),
    },
    virtualClassCounts: {
      1: Number(virtualCountsArr[1] ?? 0),
      2: Number(virtualCountsArr[2] ?? 0),
      3: Number(virtualCountsArr[3] ?? 0),
    },
    periodLabels,
    hasClassroomInfo: Number(payload['강의실'] ?? 0) === 1,
    notices: {
      comci: typeof payload['컴시간'] === 'string' ? payload['컴시간'] : null,
      school: typeof payload['학교전달'] === 'string' ? payload['학교전달'] : null,
    },
  };
}

export function parseClassTimetable(
  payload: RawTimetablePayload,
  session: ComciSessionConfig,
  schoolCode: number,
  grade: number,
  classNumber: number,
  weekIndex: number,
  schoolNameOverride?: string
): ClassTimetable {
  if (!Number.isInteger(grade) || grade < 1 || grade > 3) {
    throw new ComciValidationError(`학년은 1~3 사이의 정수여야 합니다. (입력: ${grade})`);
  }

  const meta = extractSchoolMeta(payload, session, schoolCode, weekIndex, schoolNameOverride);
  const maxClasses = meta.classCounts[grade as 1 | 2 | 3] ?? 0;

  if (!Number.isInteger(classNumber) || classNumber < 1 || classNumber > maxClasses) {
    throw new ComciValidationError(
      `${grade}학년의 학급 번호는 1~${maxClasses} 사이여야 합니다. (입력: ${classNumber})`
    );
  }

  const { fields } = session;
  const splitDivisor = payload['분리'] === undefined ? 100 : Number(payload['분리']);
  const changeNoticeFlag = Number(payload['변경알림'] ?? 0);
  const teachers = (payload[fields.teachersKey] as string[] | undefined) ?? [];
  const subjects = (payload[fields.subjectsKey] as string[] | undefined) ?? [];
  const originalArr = (payload[fields.originalTimetableKey] as unknown[][][][] | undefined) ?? [];
  const dailyArr = (payload[fields.dailyTimetableKey] as unknown[][][][] | undefined) ?? [];
  const weekdayPeriodCounts = (payload['요일별시수'] as number[][] | undefined) ?? [];

  const days: TimetableDay[] = [];

  for (const weekday of [1, 2, 3, 4, 5] as WeekdayNumber[]) {
    const date = addDaysIso(meta.weekStartDate, weekday - 1);
    const restricted = isDateRestricted(date, payload['열람제한일']);
    const classMaxPeriod = Number(dailyArr?.[grade]?.[classNumber]?.[weekday]?.[0] ?? 0);
    const normalMaxPeriod = Number(weekdayPeriodCounts?.[grade]?.[weekday] ?? 0);
    const periods: TimetablePeriod[] = [];

    for (let period = 1; period <= 8; period++) {
      const periodLabel = meta.periodLabels[period - 1] ?? `${period}교시`;

      if (restricted) {
        periods.push({
          period,
          periodLabel,
          subject: null,
          subjectCode: null,
          teacher: null,
          teacherCode: null,
          classroom: null,
          classroomCode: null,
          groupCode: null,
          displaySubject: null,
          isEmpty: true,
          isChanged: false,
          isRestricted: true,
          original: null,
        });
        continue;
      }

      const originalRaw = originalArr?.[grade]?.[classNumber]?.[weekday]?.[period] as
        | string
        | number
        | undefined;
      const dailyRaw = dailyArr?.[grade]?.[classNumber]?.[weekday]?.[period] as
        | string
        | number
        | undefined;

      const { teacherIdx, subjectIdx: rawSubjectIdx, isChanged } = splitCellPair(
        dailyRaw,
        originalRaw,
        changeNoticeFlag
      );

      if (teacherIdx > 0) {
        const splitGroup = getGroupPrefixFromSplit(rawSubjectIdx, splitDivisor);
        const subjectCode = rawSubjectIdx % splitDivisor;
        const subject = decodeXorEucKr(subjects[subjectCode], session.xorKey);
        const teacher = formatTeacherName(teachers[teacherIdx], session.xorKey);
        const groupCode =
          splitGroup ??
          computeSimultaneousGroupCode(
            payload,
            fields.dailyTimetableKey,
            grade,
            classNumber,
            subjectCode,
            weekday,
            period
          );
        const { classroom, classroomCode } = parseClassroom(
          payload,
          fields.classroomKey,
          grade,
          classNumber,
          weekday,
          period
        );

        let original: OriginalPeriodInfo | null = null;
        if (isChanged && originalRaw !== undefined && originalRaw !== 0) {
          const origParts = splitCellNumber(String(originalRaw).replace(/^>/, ''));
          const origTeacherIdx = origParts[0] ?? 0;
          const origRawSubjectIdx = (origParts[1] ?? 0) + Number(origParts[2] ?? 0) * 1000;
          if (origTeacherIdx > 0) {
            const origSubjectCode = origRawSubjectIdx % splitDivisor;
            original = {
              subject: decodeXorEucKr(subjects[origSubjectCode], session.xorKey),
              subjectCode: origSubjectCode,
              teacher: formatTeacherName(teachers[origTeacherIdx], session.xorKey),
              teacherCode: origTeacherIdx,
            };
          }
        }

        periods.push({
          period,
          periodLabel,
          subject,
          subjectCode,
          teacher,
          teacherCode: teacherIdx,
          classroom,
          classroomCode,
          groupCode,
          displaySubject: groupCode ? `${groupCode}_${subject}` : subject,
          isEmpty: false,
          isChanged,
          isRestricted: false,
          original,
        });
      } else {
        const emptyChanged = period > classMaxPeriod && period <= normalMaxPeriod;
        let original: OriginalPeriodInfo | null = null;
        if (emptyChanged && originalRaw !== undefined && originalRaw !== 0) {
          const origParts = splitCellNumber(String(originalRaw).replace(/^>/, ''));
          const origTeacherIdx = origParts[0] ?? 0;
          const origRawSubjectIdx = (origParts[1] ?? 0) + Number(origParts[2] ?? 0) * 1000;
          if (origTeacherIdx > 0) {
            const origSubjectCode = origRawSubjectIdx % splitDivisor;
            original = {
              subject: decodeXorEucKr(subjects[origSubjectCode], session.xorKey),
              subjectCode: origSubjectCode,
              teacher: formatTeacherName(teachers[origTeacherIdx], session.xorKey),
              teacherCode: origTeacherIdx,
            };
          }
        }

        periods.push({
          period,
          periodLabel,
          subject: null,
          subjectCode: null,
          teacher: null,
          teacherCode: null,
          classroom: null,
          classroomCode: null,
          groupCode: null,
          displaySubject: null,
          isEmpty: true,
          isChanged: emptyChanged,
          isRestricted: false,
          original,
        });
      }
    }

    days.push({
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday],
      date,
      maxPeriod: classMaxPeriod,
      normalMaxPeriod,
      periods,
    });
  }

  return {
    ...meta,
    grade,
    classNumber,
    days,
  };
}
