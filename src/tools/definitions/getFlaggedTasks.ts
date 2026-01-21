import { z } from 'zod';
import { getFlaggedTasks } from '../primitives/getFlaggedTasks.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

// Task status enum for filtering
const TaskStatusEnum = z.enum([
  "Available", "Next", "Blocked", "DueSoon", "Overdue", "Completed", "Dropped"
]);

export const schema = z.object({
  // Existing filters
  hideCompleted: z.boolean().optional().describe("Set to false to show completed flagged tasks (default: true)"),
  projectFilter: z.string().optional().describe("Filter flagged tasks by project name (optional)"),
  
  // Task status filtering
  taskStatus: z.array(TaskStatusEnum).optional()
    .describe("Filter by task status. Can specify multiple statuses"),
  
  // Tag filtering
  tagFilter: z.union([z.string(), z.array(z.string())]).optional()
    .describe("Filter by tag name(s). Can be single tag or array of tags"),
  exactTagMatch: z.boolean().optional()
    .describe("Set to true for exact tag name match, false for partial (default: false)"),
  
  // Due date filtering
  dueBefore: z.string().optional()
    .describe("Show tasks due before this date (ISO format: YYYY-MM-DD)"),
  dueAfter: z.string().optional()
    .describe("Show tasks due after this date (ISO format: YYYY-MM-DD)"),
  dueToday: z.boolean().optional().describe("Show tasks due today"),
  dueThisWeek: z.boolean().optional().describe("Show tasks due this week"),
  dueThisMonth: z.boolean().optional().describe("Show tasks due this month"),
  overdue: z.boolean().optional().describe("Show overdue tasks only"),
  hasDueDate: z.boolean().optional()
    .describe("Filter by whether task has a due date (true = has due date, false = no due date)"),
  
  // Defer date filtering
  deferBefore: z.string().optional()
    .describe("Show tasks with defer date before this date (ISO format: YYYY-MM-DD)"),
  deferAfter: z.string().optional()
    .describe("Show tasks with defer date after this date (ISO format: YYYY-MM-DD)"),
  deferToday: z.boolean().optional().describe("Show tasks deferred to today"),
  deferThisWeek: z.boolean().optional().describe("Show tasks deferred to this week"),
  deferAvailable: z.boolean().optional()
    .describe("Show tasks whose defer date has passed (now available)"),
  hasDeferDate: z.boolean().optional()
    .describe("Filter by whether task has a defer date (true = has defer date, false = no defer date)"),
  
  // Other filters
  searchText: z.string().optional()
    .describe("Search in task names and notes"),
  hasEstimate: z.boolean().optional()
    .describe("Filter tasks that have time estimates"),
  estimateMin: z.number().optional().describe("Minimum estimated minutes"),
  estimateMax: z.number().optional().describe("Maximum estimated minutes"),
  hasNote: z.boolean().optional().describe("Filter tasks that have notes"),
  
  // Output controls
  limit: z.number().max(1000).optional()
    .describe("Maximum number of tasks to return (default: 100)"),
  sortBy: z.enum(["name", "dueDate", "deferDate", "project", "estimatedMinutes"])
    .optional().describe("Sort results by field"),
  sortOrder: z.enum(["asc", "desc"]).optional()
    .describe("Sort order (default: asc)")
});

export async function handler(args: z.infer<typeof schema>, extra: RequestHandlerExtra) {
  try {
    const result = await getFlaggedTasks({
      // Basic filters
      hideCompleted: args.hideCompleted !== false, // Default to true
      projectFilter: args.projectFilter,
      
      // Task status
      taskStatus: args.taskStatus,
      
      // Tags
      tagFilter: args.tagFilter,
      exactTagMatch: args.exactTagMatch,
      
      // Due dates
      dueBefore: args.dueBefore,
      dueAfter: args.dueAfter,
      dueToday: args.dueToday,
      dueThisWeek: args.dueThisWeek,
      dueThisMonth: args.dueThisMonth,
      overdue: args.overdue,
      hasDueDate: args.hasDueDate,
      
      // Defer dates
      deferBefore: args.deferBefore,
      deferAfter: args.deferAfter,
      deferToday: args.deferToday,
      deferThisWeek: args.deferThisWeek,
      deferAvailable: args.deferAvailable,
      hasDeferDate: args.hasDeferDate,
      
      // Other
      searchText: args.searchText,
      hasEstimate: args.hasEstimate,
      estimateMin: args.estimateMin,
      estimateMax: args.estimateMax,
      hasNote: args.hasNote,
      
      // Output controls
      limit: args.limit,
      sortBy: args.sortBy,
      sortOrder: args.sortOrder
    });
    
    return {
      content: [{
        type: "text" as const,
        text: result
      }]
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
    return {
      content: [{
        type: "text" as const,
        text: `Error getting flagged tasks: ${errorMessage}`
      }],
      isError: true
    };
  }
}