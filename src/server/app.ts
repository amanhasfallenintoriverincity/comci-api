import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { ComciClient } from '../core/client.js';
import { ComciApiError } from '../core/errors.js';

export interface CreateAppOptions {
  client?: ComciClient;
}

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, '검색어(q)를 입력해 주세요.'),
});

const weekQuerySchema = z.object({
  week: z.coerce.number().int().min(1).default(1),
});

const classTimetableQuerySchema = z.object({
  grade: z.coerce.number().int().min(1).max(3),
  class: z.coerce.number().int().min(1),
  week: z.coerce.number().int().min(1).default(1),
  weekday: z.coerce.number().int().min(1).max(5).optional(),
});

const quickTimetableQuerySchema = z.object({
  school: z.string().trim().min(1, '학교명(school)을 입력해 주세요.'),
  grade: z.coerce.number().int().min(1).max(3),
  class: z.coerce.number().int().min(1),
  week: z.coerce.number().int().min(1).default(1),
  weekday: z.coerce.number().int().min(1).max(5).optional(),
});

const schoolCodeParamSchema = z.coerce.number().int().positive('유효한 학교 코드가 아닙니다.');

export function createApp(options: CreateAppOptions = {}) {
  const client = options.client ?? new ComciClient();
  const app = new Hono();

  app.use('*', cors());

  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: err.issues[0]?.message ?? '요청 파라미터가 올바르지 않습니다.',
            issues: err.issues,
          },
        },
        400
      );
    }

    if (err instanceof ComciApiError) {
      const status = ([400, 403, 404, 429, 502, 503].includes(err.statusCode)
        ? err.statusCode
        : 500) as 400 | 403 | 404 | 429 | 500 | 502 | 503;

      return c.json(
        {
          success: false,
          error: {
            code: err.code,
            message: err.message,
          },
        },
        status
      );
    }

    const message = err instanceof Error ? err.message : 'Internal server error';
    return c.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message,
        },
      },
      500
    );
  });

  app.get('/', (c) => {
    return c.json({
      name: 'comci-api',
      description: 'Unofficial Comcigan Student Timetable API (컴시간 학생시간표 비공식 API)',
      endpoints: [
        'GET /health',
        'GET /api/schools?q={학교명}',
        'GET /api/schools/{schoolCode}/meta?week={1}',
        'GET /api/schools/{schoolCode}/timetable?grade={1..3}&class={반}&week={1}&weekday={1..5}',
        'GET /api/schools/{schoolCode}/classes/{grade}/{class}?week={1}&weekday={1..5}',
        'GET /api/timetable?school={학교명}&grade={1..3}&class={반}&week={1}&weekday={1..5}',
      ],
    });
  });

  app.get('/health', (c) => {
    return c.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/schools', async (c) => {
    const { q } = searchQuerySchema.parse(c.req.query());
    const schools = await client.searchSchools(q);
    return c.json({
      success: true,
      query: q,
      count: schools.length,
      schools,
    });
  });

  app.get('/api/schools/:schoolCode/meta', async (c) => {
    const schoolCode = schoolCodeParamSchema.parse(c.req.param('schoolCode'));
    const { week } = weekQuerySchema.parse(c.req.query());
    const meta = await client.getSchoolMeta(schoolCode, week);
    return c.json({
      success: true,
      meta,
    });
  });

  app.get('/api/schools/:schoolCode/timetable', async (c) => {
    const schoolCode = schoolCodeParamSchema.parse(c.req.param('schoolCode'));
    const query = classTimetableQuerySchema.parse(c.req.query());
    const timetable = await client.getClassTimetable(
      schoolCode,
      query.grade,
      query.class,
      query.week
    );
    const filtered =
      query.weekday !== undefined
        ? { ...timetable, days: timetable.days.filter((d) => d.weekday === query.weekday) }
        : timetable;
    return c.json({
      success: true,
      timetable: filtered,
    });
  });

  app.get('/api/schools/:schoolCode/classes/:grade/:classNumber', async (c) => {
    const schoolCode = schoolCodeParamSchema.parse(c.req.param('schoolCode'));
    const params = z
      .object({
        grade: z.coerce.number().int().min(1).max(3),
        classNumber: z.coerce.number().int().min(1),
      })
      .parse({
        grade: c.req.param('grade'),
        classNumber: c.req.param('classNumber'),
      });
    const query = z
      .object({
        week: z.coerce.number().int().min(1).default(1),
        weekday: z.coerce.number().int().min(1).max(5).optional(),
      })
      .parse(c.req.query());

    const timetable = await client.getClassTimetable(
      schoolCode,
      params.grade,
      params.classNumber,
      query.week
    );
    const filtered =
      query.weekday !== undefined
        ? { ...timetable, days: timetable.days.filter((d) => d.weekday === query.weekday) }
        : timetable;
    return c.json({
      success: true,
      timetable: filtered,
    });
  });

  app.get('/api/timetable', async (c) => {
    const query = quickTimetableQuerySchema.parse(c.req.query());
    const { school, timetable } = await client.findAndGetClassTimetable(
      query.school,
      query.grade,
      query.class,
      query.week
    );
    const filtered =
      query.weekday !== undefined
        ? { ...timetable, days: timetable.days.filter((d) => d.weekday === query.weekday) }
        : timetable;
    return c.json({
      success: true,
      school,
      timetable: filtered,
    });
  });

  return app;
}
