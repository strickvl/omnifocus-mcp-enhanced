import { editItem, EditItemParams } from './editItem.js';

// Re-export the params type for the batch operation
export type BatchEditItemsParams = EditItemParams;

// Define the result type for individual operations
type ItemResult = {
  success: boolean;
  id?: string;
  name?: string;
  changedProperties?: string;
  error?: string;
};

// Define the result type for the batch operation
type BatchResult = {
  success: boolean;
  results: ItemResult[];
  error?: string;
};

/**
 * Edit multiple items (tasks or projects) in OmniFocus
 *
 * Processes items sequentially, calling editItem for each.
 * Overall success is true if at least one item was edited successfully.
 */
export async function batchEditItems(items: BatchEditItemsParams[]): Promise<BatchResult> {
  try {
    // Results array to track individual operation outcomes
    const results: ItemResult[] = [];

    // Process each item in sequence
    for (const item of items) {
      try {
        // Call editItem for this item
        const itemResult = await editItem(item);

        results.push({
          success: itemResult.success,
          id: itemResult.id,
          name: itemResult.name,
          changedProperties: itemResult.changedProperties,
          error: itemResult.error
        });
      } catch (itemError: any) {
        // Handle individual item errors
        results.push({
          success: false,
          error: itemError.message || "Unknown error processing item"
        });
      }
    }

    // Determine overall success (true if at least one item was edited successfully)
    const overallSuccess = results.some(result => result.success);

    return {
      success: overallSuccess,
      results: results
    };
  } catch (error: any) {
    console.error("Error in batchEditItems:", error);
    return {
      success: false,
      results: [],
      error: error.message || "Unknown error in batchEditItems"
    };
  }
}
