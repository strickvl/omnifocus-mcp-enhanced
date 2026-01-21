import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseIsoDateInput,
  appleScriptDateExpr,
  APPLESCRIPT_DATE_HELPERS,
  IsoDateParts
} from '../../utils/omnifocusDate.js';
const execAsync = promisify(exec);

/**
 * Execute AppleScript safely using a temp file.
 * This avoids shell escaping issues with special characters (quotes, etc.)
 */
async function executeAppleScript(script: string): Promise<{ stdout: string; stderr: string }> {
  const tempFile = join(tmpdir(), `applescript_${Date.now()}_${Math.random().toString(36).slice(2)}.scpt`);
  try {
    writeFileSync(tempFile, script);
    const result = await execAsync(`osascript ${tempFile}`);
    return result;
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Interface for project creation parameters
export interface AddProjectParams {
  name: string;
  note?: string;
  dueDate?: string; // ISO date string
  deferDate?: string; // ISO date string
  flagged?: boolean;
  estimatedMinutes?: number;
  tags?: string[]; // Tag names
  folderName?: string; // Folder name to add project to
  sequential?: boolean; // Whether tasks should be sequential or parallel
}

/**
 * Internal params with pre-parsed date parts
 */
interface ResolvedProjectParams extends Omit<AddProjectParams, 'dueDate' | 'deferDate'> {
  dueDateParts?: IsoDateParts;
  deferDateParts?: IsoDateParts;
}

/**
 * Generate pure AppleScript for project creation
 */
function generateAppleScript(params: ResolvedProjectParams): string {
  // Sanitize and prepare parameters for AppleScript
  const name = params.name.replace(/["\\]/g, '\\$&'); // Escape quotes and backslashes
  const note = params.note?.replace(/["\\]/g, '\\$&') || '';
  const flagged = params.flagged === true;
  const estimatedMinutes = params.estimatedMinutes?.toString() || '';
  const tags = params.tags || [];
  const folderName = params.folderName?.replace(/["\\]/g, '\\$&') || '';
  const sequential = params.sequential === true;

  // Check if we need the date helper function
  const needsDateHelper = params.dueDateParts || params.deferDateParts;

  // Construct AppleScript with error handling
  let script = needsDateHelper ? APPLESCRIPT_DATE_HELPERS : '';
  script += `
  try
    tell application "OmniFocus"
      tell front document
        -- Determine the container (root or folder)
        if "${folderName}" is "" then
          -- Create project at the root level
          set newProject to make new project with properties {name:"${name}"}
        else
          -- Use specified folder
          try
            set theFolder to first flattened folder where name = "${folderName}"
            set newProject to make new project with properties {name:"${name}"} at end of projects of theFolder
          on error
            return "{\\\"success\\\":false,\\\"error\\\":\\\"Folder not found: ${folderName}\\\"}"
          end try
        end if

        -- Set project properties
        ${note ? `set note of newProject to "${note}"` : ''}
        ${params.dueDateParts ? `set due date of newProject to ${appleScriptDateExpr(params.dueDateParts)}` : ''}
        ${params.deferDateParts ? `set defer date of newProject to ${appleScriptDateExpr(params.deferDateParts)}` : ''}
        ${flagged ? `set flagged of newProject to true` : ''}
        ${estimatedMinutes ? `set estimated minutes of newProject to ${estimatedMinutes}` : ''}
        ${`set sequential of newProject to ${sequential}`}
        
        -- Get the project ID
        set projectId to id of newProject as string
        
        -- Add tags if provided
        ${tags.length > 0 ? tags.map(tag => {
          const sanitizedTag = tag.replace(/["\\]/g, '\\$&');
          return `
          try
            set theTag to first flattened tag where name = "${sanitizedTag}"
            add theTag to tags of newProject
          on error
            -- Ignore errors finding/adding tags
          end try`;
        }).join('\n') : ''}
        
        -- Return success with project ID
        return "{\\\"success\\\":true,\\\"projectId\\\":\\"" & projectId & "\\",\\\"name\\\":\\"${name}\\"}"
      end tell
    end tell
  on error errorMessage
    return "{\\\"success\\\":false,\\\"error\\\":\\"" & errorMessage & "\\"}"
  end try
  `;
  
  return script;
}

/**
 * Add a project to OmniFocus
 */
export async function addProject(params: AddProjectParams): Promise<{success: boolean, projectId?: string, error?: string}> {
  try {
    // Parse dates in TypeScript (avoids AppleScript's locale-ambiguous parsing)
    let dueDateParts: IsoDateParts | undefined;
    let deferDateParts: IsoDateParts | undefined;

    if (params.dueDate) {
      try {
        dueDateParts = parseIsoDateInput(params.dueDate);
      } catch (dateError: any) {
        return {
          success: false,
          error: `Invalid dueDate: ${dateError.message}`
        };
      }
    }

    if (params.deferDate) {
      try {
        deferDateParts = parseIsoDateInput(params.deferDate);
      } catch (dateError: any) {
        return {
          success: false,
          error: `Invalid deferDate: ${dateError.message}`
        };
      }
    }

    // Build resolved params with parsed dates
    const resolvedParams: ResolvedProjectParams = {
      name: params.name,
      note: params.note,
      flagged: params.flagged,
      estimatedMinutes: params.estimatedMinutes,
      tags: params.tags,
      folderName: params.folderName,
      sequential: params.sequential,
      dueDateParts,
      deferDateParts
    };

    // Generate AppleScript
    const script = generateAppleScript(resolvedParams);
    
    console.error("Executing AppleScript directly...");
    
    // Execute AppleScript via temp file (avoids shell escaping issues)
    const { stdout, stderr } = await executeAppleScript(script);
    
    if (stderr) {
      console.error("AppleScript stderr:", stderr);
    }
    
    console.error("AppleScript stdout:", stdout);
    
    // Parse the result
    try {
      const result = JSON.parse(stdout);
      
      // Return the result
      return {
        success: result.success,
        projectId: result.projectId,
        error: result.error
      };
    } catch (parseError) {
      console.error("Error parsing AppleScript result:", parseError);
      return {
        success: false,
        error: `Failed to parse result: ${stdout}`
      };
    }
  } catch (error: any) {
    console.error("Error in addProject:", error);
    return {
      success: false,
      error: error?.message || "Unknown error in addProject"
    };
  }
} 