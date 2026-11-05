/** Workers nodejs_als exposes only the AsyncLocalStorage subset used here.
 * Avoid enabling Node ambient globals or installing dependencies in the Worker. */
declare module 'node:async_hooks' {
    export class AsyncLocalStorage<T> {
        getStore(): T | undefined;
        run<R>(store: T, callback: () => R): R;
    }
}
