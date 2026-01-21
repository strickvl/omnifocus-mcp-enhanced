import { executeOmniFocusScript } from '../../utils/scriptExecution.js';

export interface GetFlaggedTasksOptions {
  // Basic filters
  hideCompleted?: boolean;
  projectFilter?: string;
  
  // Task status
  taskStatus?: string[];
  
  // Tag filters
  tagFilter?: string | string[];
  exactTagMatch?: boolean;
  
  // Due date filters
  dueBefore?: string;
  dueAfter?: string;
  dueToday?: boolean;
  dueThisWeek?: boolean;
  dueThisMonth?: boolean;
  overdue?: boolean;
  hasDueDate?: boolean;
  
  // Defer date filters
  deferBefore?: string;
  deferAfter?: string;
  deferToday?: boolean;
  deferThisWeek?: boolean;
  deferAvailable?: boolean;
  hasDeferDate?: boolean;
  
  // Other filters
  searchText?: string;
  hasEstimate?: boolean;
  estimateMin?: number;
  estimateMax?: number;
  hasNote?: boolean;
  
  // Output controls
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/**
 * Build a human-readable summary of active filters
 */
function buildFilterSummary(options: GetFlaggedTasksOptions): string {
  const parts: string[] = [];
  
  if (options.projectFilter) {
    parts.push(`project: "${options.projectFilter}"`);
  }
  
  if (options.taskStatus && options.taskStatus.length > 0) {
    parts.push(`status: ${options.taskStatus.join(', ')}`);
  }
  
  if (options.tagFilter) {
    const tags = Array.isArray(options.tagFilter) ? options.tagFilter : [options.tagFilter];
    parts.push(`tags: ${tags.join(', ')}`);
  }
  
  // Due date filters
  if (options.dueToday) parts.push('due today');
  if (options.dueThisWeek) parts.push('due this week');
  if (options.dueThisMonth) parts.push('due this month');
  if (options.overdue) parts.push('overdue');
  if (options.hasDueDate === true) parts.push('has due date');
  if (options.hasDueDate === false) parts.push('no due date');
  if (options.dueBefore) parts.push(`due before ${options.dueBefore}`);
  if (options.dueAfter) parts.push(`due after ${options.dueAfter}`);
  
  // Defer date filters
  if (options.deferAvailable) parts.push('available now (defer passed)');
  if (options.deferToday) parts.push('deferred to today');
  if (options.deferThisWeek) parts.push('deferred this week');
  if (options.hasDeferDate === true) parts.push('has defer date');
  if (options.hasDeferDate === false) parts.push('no defer date');
  if (options.deferBefore) parts.push(`deferred before ${options.deferBefore}`);
  if (options.deferAfter) parts.push(`deferred after ${options.deferAfter}`);
  
  // Other filters
  if (options.searchText) parts.push(`search: "${options.searchText}"`);
  if (options.hasEstimate === true) parts.push('has estimate');
  if (options.hasEstimate === false) parts.push('no estimate');
  if (options.estimateMin) parts.push(`≥${options.estimateMin}min`);
  if (options.estimateMax) parts.push(`≤${options.estimateMax}min`);
  if (options.hasNote === true) parts.push('has notes');
  if (options.hasNote === false) parts.push('no notes');
  
  return parts.join(' • ');
}

export async function getFlaggedTasks(options: GetFlaggedTasksOptions = {}): Promise<string> {
  const { hideCompleted = true } = options;
  
  try {
    // Execute the flagged tasks script with all filter options
    const result = await executeOmniFocusScript('@flaggedTasks.js', { 
      hideCompleted,
      projectFilter: options.projectFilter,
      taskStatus: options.taskStatus,
      tagFilter: options.tagFilter,
      exactTagMatch: options.exactTagMatch ?? false,
      dueBefore: options.dueBefore,
      dueAfter: options.dueAfter,
      dueToday: options.dueToday,
      dueThisWeek: options.dueThisWeek,
      dueThisMonth: options.dueThisMonth,
      overdue: options.overdue,
      hasDueDate: options.hasDueDate,
      deferBefore: options.deferBefore,
      deferAfter: options.deferAfter,
      deferToday: options.deferToday,
      deferThisWeek: options.deferThisWeek,
      deferAvailable: options.deferAvailable,
      hasDeferDate: options.hasDeferDate,
      searchText: options.searchText,
      hasEstimate: options.hasEstimate,
      estimateMin: options.estimateMin,
      estimateMax: options.estimateMax,
      hasNote: options.hasNote,
      limit: options.limit ?? 100,
      sortBy: options.sortBy ?? "name",
      sortOrder: options.sortOrder ?? "asc"
    });
    
    if (typeof result === 'string') {
      return result;
    }
    
    // If result is an object, format it
    if (result && typeof result === 'object') {
      const data = result as any;
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      // Build header
      let output = `# 🚩 FLAGGED TASKS\n\n`;
      
      // Add filter summary if any filters are active
      const filterSummary = buildFilterSummary(options);
      if (filterSummary) {
        output += `**Filters**: ${filterSummary}\n\n`;
      }
      
      // Add sorting info if non-default
      if (options.sortBy && options.sortBy !== 'name') {
        output += `**Sorted by**: ${options.sortBy} (${options.sortOrder || 'asc'})\n\n`;
      }
      
      if (data.tasks && Array.isArray(data.tasks)) {
        if (data.tasks.length === 0) {
          if (filterSummary) {
            output += `No flagged tasks match your filters.\n`;
          } else {
            output += "🎉 No flagged tasks - nice and clean!\n";
          }
        } else {
          // Show count with context about filtering
          const returnedCount = data.tasks.length;
          const filteredCount = data.filteredCount || returnedCount;
          const totalCount = data.totalFlaggedCount || filteredCount;
          
          if (filterSummary || filteredCount !== totalCount) {
            output += `Showing ${returnedCount} of ${filteredCount} matching tasks (${totalCount} total flagged)\n\n`;
          } else {
            output += `Found ${returnedCount} flagged task${returnedCount === 1 ? '' : 's'}:\n\n`;
          }
          
          // Group tasks by project for better organization
          const tasksByProject = new Map<string, any[]>();
          
          data.tasks.forEach((task: any) => {
            const projectName = task.projectName || '📥 Inbox';
            if (!tasksByProject.has(projectName)) {
              tasksByProject.set(projectName, []);
            }
            tasksByProject.get(projectName)!.push(task);
          });
          
          // Display tasks grouped by project
          tasksByProject.forEach((tasks, projectName) => {
            if (tasksByProject.size > 1) {
              output += `## 📁 ${projectName}\n`;
            }
            
            tasks.forEach((task: any) => {
              const dueDateStr = task.dueDate ? ` [DUE: ${new Date(task.dueDate).toLocaleDateString()}]` : '';
              const deferDateStr = task.deferDate ? ` [DEFER: ${new Date(task.deferDate).toLocaleDateString()}]` : '';
              const statusStr = task.taskStatus !== 'Available' ? ` (${task.taskStatus})` : '';
              const estimateStr = task.estimatedMinutes ? ` ⏱${task.estimatedMinutes}m` : '';
              
              output += `• 🚩 ${task.name}${dueDateStr}${deferDateStr}${statusStr}${estimateStr}\n`;
              
              if (task.note && task.note.trim()) {
                output += `  📝 ${task.note.trim()}\n`;
              }
              
              if (task.tags && task.tags.length > 0) {
                const tagNames = task.tags.map((tag: any) => tag.name).join(', ');
                output += `  🏷 ${tagNames}\n`;
              }
              
              output += '\n';
            });
          });
        }
      } else {
        output += "No flagged tasks data available\n";
      }
      
      return output;
    }
    
    return "Unexpected result format from OmniFocus";
    
  } catch (error) {
    console.error("Error in getFlaggedTasks:", error);
    throw new Error(`Failed to get flagged tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}