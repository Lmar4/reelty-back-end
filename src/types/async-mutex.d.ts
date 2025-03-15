declare module "async-mutex" {
  export class Semaphore {
    constructor(count: number);
    acquire(): Promise<() => void>;
    runExclusive<T>(callback: () => Promise<T> | T): Promise<T>;
    release(): void;
    isLocked(): boolean;
    getValue(): number;
  }

  export class Mutex {
    constructor();
    acquire(): Promise<() => void>;
    runExclusive<T>(callback: () => Promise<T> | T): Promise<T>;
    release(): void;
    isLocked(): boolean;
  }

  export class withTimeout<T> {
    static Mutex(mutex: Mutex, timeout: number): Mutex;
    static Semaphore(semaphore: Semaphore, timeout: number): Semaphore;
  }
}
