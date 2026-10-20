/** 시간 재기 — 여러 층이 같이 쓴다 */

/** 약속이 `ms` 안에 안 끝나면 `message` 로 거절한다. 타이머는 어느 쪽이든 걷는다 */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}
