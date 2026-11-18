import { z } from '@hono/zod-openapi';
import { timerTriggerConfigSchema } from '@archon/core/workflows/timer-bindings';
import { workflowRunOutcomeSchema, workflowRunStatusSchema } from './workflow.schemas';

export const timerScheduleSchema = timerTriggerConfigSchema.shape.schedule.openapi('TimerSchedule');

const bindingLastRunSchema = z
  .object({
    runId: z.string(),
    status: workflowRunStatusSchema,
    outcome: workflowRunOutcomeSchema,
    startedAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi('TriggerBindingLastRun');

const validTriggerBindingSchema = z.object({
  file: z.string(),
  status: z.literal('valid'),
  bindingId: z.string(),
  workflowName: z.string(),
  cwd: z.string().openapi({ description: 'The launch folder (binding.launch.cwd).' }),
  hostId: z.string(),
  schedule: timerScheduleSchema,
  scheduleInstalled: z.boolean().nullable().openapi({
    description:
      "Whether the binding's LaunchAgent plist exists; null when this host cannot tell (see scheduleError).",
  }),
  scheduleError: z.string().optional(),
  lastRun: bindingLastRunSchema.nullable().openapi({
    description: 'The newest run a resource start began for this binding.',
  }),
  nextFireAt: z.string().nullable().openapi({
    description:
      "The next fire time, computed from the schedule in the server's local time zone. For a calendar binding it is exact. For an interval binding it is an estimate: the start of the last run plus whole intervals, while launchd counts from the load of the job. Null when no schedule is installed, or for an interval binding with no run to count from.",
  }),
});

const invalidTriggerBindingSchema = z.object({
  file: z.string(),
  status: z.literal('invalid'),
  reason: z.string(),
});

export const triggerBindingSchema = z
  .discriminatedUnion('status', [validTriggerBindingSchema, invalidTriggerBindingSchema])
  .openapi('TriggerBinding');

export const triggerBindingsResponseSchema = z
  .object({
    timeZone: z.string().openapi({ description: "The server's IANA time zone." }),
    generatedAt: z.string(),
    bindings: z.array(triggerBindingSchema),
  })
  .openapi('TriggerBindingsResponse');

export type TriggerBindingsResponse = z.infer<typeof triggerBindingsResponseSchema>;
