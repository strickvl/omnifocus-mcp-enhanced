// OmniJS script to get flagged tasks from OmniFocus with filtering support
(() => {
  try {
    // Get parameters from injectedArgs (following filterTasks.js pattern)
    const args = typeof injectedArgs !== 'undefined' ? injectedArgs : {};
    
    const filters = {
      // Basic filters
      hideCompleted: args.hideCompleted !== undefined ? args.hideCompleted : true,
      projectFilter: args.projectFilter || null,
      
      // Task status filter
      taskStatus: args.taskStatus || null,
      
      // Tag filters
      tagFilter: args.tagFilter || null,
      exactTagMatch: args.exactTagMatch || false,
      
      // Due date filters
      dueBefore: args.dueBefore || null,
      dueAfter: args.dueAfter || null,
      dueToday: args.dueToday || false,
      dueThisWeek: args.dueThisWeek || false,
      dueThisMonth: args.dueThisMonth || false,
      overdue: args.overdue || false,
      hasDueDate: args.hasDueDate !== undefined ? args.hasDueDate : null,
      
      // Defer date filters
      deferBefore: args.deferBefore || null,
      deferAfter: args.deferAfter || null,
      deferToday: args.deferToday || false,
      deferThisWeek: args.deferThisWeek || false,
      deferAvailable: args.deferAvailable || false,
      hasDeferDate: args.hasDeferDate !== undefined ? args.hasDeferDate : null,
      
      // Other filters
      searchText: args.searchText || null,
      hasEstimate: args.hasEstimate !== undefined ? args.hasEstimate : null,
      estimateMin: args.estimateMin || null,
      estimateMax: args.estimateMax || null,
      hasNote: args.hasNote !== undefined ? args.hasNote : null,
      
      // Output controls
      limit: args.limit || 100,
      sortBy: args.sortBy || "name",
      sortOrder: args.sortOrder || "asc"
    };
    
    // Helper function to format dates consistently
    function formatDate(date) {
      if (!date) return null;
      return date.toISOString();
    }
    
    // Get task status enum mapping
    const taskStatusMap = {
      [Task.Status.Available]: "Available",
      [Task.Status.Blocked]: "Blocked", 
      [Task.Status.Completed]: "Completed",
      [Task.Status.Dropped]: "Dropped",
      [Task.Status.DueSoon]: "DueSoon",
      [Task.Status.Next]: "Next",
      [Task.Status.Overdue]: "Overdue"
    };
    
    function getTaskStatus(status) {
      return taskStatusMap[status] || "Unknown";
    }
    
    // Date helper functions
    function isToday(date) {
      if (!date) return false;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      const checkDate = new Date(date);
      return checkDate >= today && checkDate < tomorrow;
    }
    
    function isThisWeek(date) {
      if (!date) return false;
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 7);
      const checkDate = new Date(date);
      return checkDate >= startOfWeek && checkDate < endOfWeek;
    }
    
    function isThisMonth(date) {
      if (!date) return false;
      const now = new Date();
      const checkDate = new Date(date);
      return checkDate.getMonth() === now.getMonth() &&
             checkDate.getFullYear() === now.getFullYear();
    }
    
    function isOverdue(dueDate) {
      if (!dueDate) return false;
      const now = new Date();
      return new Date(dueDate) < now;
    }
    
    function isDeferAvailable(deferDate) {
      if (!deferDate) return true; // No defer date means available
      return new Date(deferDate) <= new Date();
    }
    
    // Get all flagged tasks using flattenedTasks with flagged filter
    let flaggedTasks = flattenedTasks.filter(task => task.flagged);
    const totalFlaggedCount = flaggedTasks.length;
    
    // Filter by completion status if needed
    if (filters.hideCompleted) {
      flaggedTasks = flaggedTasks.filter(task => 
        task.taskStatus !== Task.Status.Completed && 
        task.taskStatus !== Task.Status.Dropped
      );
    }
    
    // Apply all additional filters
    flaggedTasks = flaggedTasks.filter(task => {
      try {
        const taskStatus = getTaskStatus(task.taskStatus);
        
        // Status filter
        if (filters.taskStatus && filters.taskStatus.length > 0) {
          if (!filters.taskStatus.includes(taskStatus)) {
            return false;
          }
        }
        
        // Project filter
        if (filters.projectFilter) {
          const projectName = task.containingProject ? task.containingProject.name : '';
          if (!projectName.toLowerCase().includes(filters.projectFilter.toLowerCase())) {
            return false;
          }
        }
        
        // Tag filter
        if (filters.tagFilter) {
          const taskTags = task.tags.map(tag => tag.name);
          const searchTags = Array.isArray(filters.tagFilter) ? filters.tagFilter : [filters.tagFilter];
          
          const hasMatchingTag = searchTags.some(searchTag => {
            return taskTags.some(taskTag => {
              if (filters.exactTagMatch) {
                return taskTag === searchTag;
              } else {
                return taskTag.toLowerCase().includes(searchTag.toLowerCase());
              }
            });
          });
          
          if (!hasMatchingTag) {
            return false;
          }
        }
        
        // Due date filters
        if (filters.hasDueDate !== null) {
          const hasDue = task.dueDate !== null;
          if (filters.hasDueDate !== hasDue) {
            return false;
          }
        }
        
        if (filters.dueBefore && task.dueDate) {
          if (new Date(task.dueDate) >= new Date(filters.dueBefore)) {
            return false;
          }
        }
        
        if (filters.dueAfter && task.dueDate) {
          if (new Date(task.dueDate) <= new Date(filters.dueAfter)) {
            return false;
          }
        }
        
        if (filters.dueToday) {
          if (!isToday(task.dueDate)) {
            return false;
          }
        }
        
        if (filters.dueThisWeek) {
          if (!isThisWeek(task.dueDate)) {
            return false;
          }
        }
        
        if (filters.dueThisMonth) {
          if (!isThisMonth(task.dueDate)) {
            return false;
          }
        }
        
        if (filters.overdue) {
          if (!isOverdue(task.dueDate)) {
            return false;
          }
        }
        
        // Defer date filters
        if (filters.hasDeferDate !== null) {
          const hasDefer = task.deferDate !== null;
          if (filters.hasDeferDate !== hasDefer) {
            return false;
          }
        }
        
        if (filters.deferBefore && task.deferDate) {
          if (new Date(task.deferDate) >= new Date(filters.deferBefore)) {
            return false;
          }
        }
        
        if (filters.deferAfter && task.deferDate) {
          if (new Date(task.deferDate) <= new Date(filters.deferAfter)) {
            return false;
          }
        }
        
        if (filters.deferToday) {
          if (!isToday(task.deferDate)) {
            return false;
          }
        }
        
        if (filters.deferThisWeek) {
          if (!isThisWeek(task.deferDate)) {
            return false;
          }
        }
        
        if (filters.deferAvailable) {
          if (!isDeferAvailable(task.deferDate)) {
            return false;
          }
        }
        
        // Search text filter
        if (filters.searchText) {
          const searchLower = filters.searchText.toLowerCase();
          const taskName = (task.name || '').toLowerCase();
          const taskNote = (task.note || '').toLowerCase();
          if (!taskName.includes(searchLower) && !taskNote.includes(searchLower)) {
            return false;
          }
        }
        
        // Estimate filters
        if (filters.hasEstimate !== null) {
          const hasEst = task.estimatedMinutes && task.estimatedMinutes > 0;
          if (filters.hasEstimate !== hasEst) {
            return false;
          }
        }
        
        if (filters.estimateMin !== null) {
          if (!task.estimatedMinutes || task.estimatedMinutes < filters.estimateMin) {
            return false;
          }
        }
        
        if (filters.estimateMax !== null) {
          if (!task.estimatedMinutes || task.estimatedMinutes > filters.estimateMax) {
            return false;
          }
        }
        
        // Note filter
        if (filters.hasNote !== null) {
          const hasNote = task.note && task.note.trim().length > 0;
          if (filters.hasNote !== hasNote) {
            return false;
          }
        }
        
        return true;
      } catch (error) {
        console.log(`Error filtering task: ${error}`);
        return false;
      }
    });
    
    // Sort filtered tasks
    flaggedTasks.sort((a, b) => {
      let valueA, valueB;
      
      switch (filters.sortBy) {
        case "name":
          valueA = a.name || '';
          valueB = b.name || '';
          break;
        case "dueDate":
          valueA = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_VALUE;
          valueB = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_VALUE;
          break;
        case "deferDate":
          valueA = a.deferDate ? new Date(a.deferDate).getTime() : Number.MAX_VALUE;
          valueB = b.deferDate ? new Date(b.deferDate).getTime() : Number.MAX_VALUE;
          break;
        case "project":
          valueA = a.containingProject ? a.containingProject.name : '';
          valueB = b.containingProject ? b.containingProject.name : '';
          break;
        case "estimatedMinutes":
          valueA = a.estimatedMinutes || 0;
          valueB = b.estimatedMinutes || 0;
          break;
        default:
          valueA = a.name || '';
          valueB = b.name || '';
      }
      
      if (valueA < valueB) return filters.sortOrder === "desc" ? 1 : -1;
      if (valueA > valueB) return filters.sortOrder === "desc" ? -1 : 1;
      return 0;
    });
    
    // Apply limit
    const countBeforeLimit = flaggedTasks.length;
    if (filters.limit && flaggedTasks.length > filters.limit) {
      flaggedTasks = flaggedTasks.slice(0, filters.limit);
    }

    const exportData = {
      exportDate: new Date().toISOString(),
      tasks: [],
      totalFlaggedCount: totalFlaggedCount,
      filteredCount: countBeforeLimit,
      returnedCount: flaggedTasks.length,
      sortedBy: filters.sortBy,
      sortOrder: filters.sortOrder
    };
    
    // Process each flagged task
    flaggedTasks.forEach(task => {
      try {
        const taskData = {
          id: task.id.primaryKey,
          name: task.name,
          note: task.note || "",
          taskStatus: getTaskStatus(task.taskStatus),
          flagged: task.flagged, // Should always be true for flagged tasks
          dueDate: formatDate(task.dueDate),
          deferDate: formatDate(task.deferDate),
          estimatedMinutes: task.estimatedMinutes,
          projectId: task.containingProject ? task.containingProject.id.primaryKey : null,
          projectName: task.containingProject ? task.containingProject.name : null,
          inInbox: task.inInbox,
          tags: task.tags.map(tag => ({
            id: tag.id.primaryKey,
            name: tag.name
          }))
        };
        
        exportData.tasks.push(taskData);
      } catch (taskError) {
        console.log(`Error processing flagged task: ${taskError}`);
      }
    });
    
    return JSON.stringify(exportData);
    
  } catch (error) {
    console.error(`Error in flaggedTasks script: ${error}`);
    return JSON.stringify({
      success: false,
      error: `Error getting flagged tasks: ${error}`
    });
  }
})();