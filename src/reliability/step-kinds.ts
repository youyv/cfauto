/** Shared admission vocabulary; executors still validate the full sealed command. */
export const TASK_STEP_KINDS: ReadonlySet<string> = new Set(['rename_subdomain', 'remove_worker', 'cleanup_kv', 'repair_worker', 'rotate_subdomain', 'manual_upload', 'upload', 'create_worker', 'replace_worker', 'delete_worker', 'configure_domain', 'change_subdomain', 'delete_kv', 'write_nodes']);
