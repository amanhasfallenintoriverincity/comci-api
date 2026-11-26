export type WeekdayNumber = 1 | 2 | 3 | 4 | 5;
export type WeekdayName = '월' | '화' | '수' | '목' | '금';

export interface ComciFieldKeys {
  teachersKey: string;
  subjectsKey: string;
  originalTimetableKey: string;
  dailyTimetableKey: string;
  classroomKey: string;
  modifiedAtKey: string;
  startDateKey: string;
  periodsKey: string;
  datesKey: string;
}

export interface ComciSessionConfig {
  entryUrl: string;
  ajaxUrl: string;
  requestToken: string;
  cookie: string;
  searchPrefix: string;
  searchSuffix: string;
  timetablePrefix: string;
  timetableSuffix: string;
  schoolCodeDivisor: number;
  xorKey: string;
  aesKeyHex: string;
  base64Prefix: string;
  fields: ComciFieldKeys;
  fetchedAt: number;
}

export interface SchoolSearchItem {
  code: number;
  name: string;
  region: string;
  rawId: number;
}

export interface AvailableWeek {
  index: number;
  label: string;
}

export interface OriginalPeriodInfo {
  subject: string;
  subjectCode: number;
  teacher: string;
  teacherCode: number;
}

export interface TimetablePeriod {
  period: number;
  periodLabel: string;
  subject: string | null;
  subjectCode: number | null;
  teacher: string | null;
  teacherCode: number | null;
  classroom: string | null;
  classroomCode: number | null;
  groupCode: string | null;
  displaySubject: string | null;
  isEmpty: boolean;
  isChanged: boolean;
  isRestricted: boolean;
  original: OriginalPeriodInfo | null;
}

export interface TimetableDay {
  weekday: WeekdayNumber;
  weekdayName: WeekdayName;
  date: string;
  maxPeriod: number;
  normalMaxPeriod: number;
  periods: TimetablePeriod[];
}

export interface SchoolNotices {
  comci: string | null;
  school: string | null;
}

export interface SchoolMeta {
  schoolCode: number;
  schoolName: string;
  payloadSchoolName: string;
  region: string;
  academicYear: number;
  semesterStartDate: string;
  modifiedAt: string;
  weekIndex: number;
  todayWeekIndex: number;
  weekStartDate: string;
  availableWeeks: AvailableWeek[];
  classCounts: Record<1 | 2 | 3, number>;
  virtualClassCounts: Record<1 | 2 | 3, number>;
  periodLabels: string[];
  hasClassroomInfo: boolean;
  notices: SchoolNotices;
}

export interface ClassTimetable extends SchoolMeta {
  grade: number;
  classNumber: number;
  days: TimetableDay[];
}

export interface ComciClientOptions {
  entryUrl?: string;
  portalUrl?: string;
  sessionTtlMs?: number;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  userAgent?: string;
}
