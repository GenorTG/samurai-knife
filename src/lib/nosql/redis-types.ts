/** Shape of one row of the generated Redis command table (`redis-commands.data.ts`). */
export interface RedisArgDef {
  /** name */
  n: string;
  /** type: key, string, integer, double, unix-time, pattern, pure-token, oneof, block */
  t: string;
  /** literal token that introduces the argument (e.g. EX, LIMIT) */
  k?: string;
  /** optional */
  o?: 1;
  /** may repeat */
  m?: 1;
  /** the token repeats with every repetition (e.g. GET pattern [GET pattern ...]) */
  mt?: 1;
  /** children for oneof / block */
  a?: RedisArgDef[];
}

export interface RedisCommandDef {
  /** `SET`, or `CLIENT SETNAME` for sub-commands */
  name: string;
  group: string;
  /** Redis arity: N >= 0 exact, -N at least N (counting the command word(s)) */
  arity: number;
  since: string;
  complexity: string;
  summary: string;
  /** ACL categories without the @: write, read, blocking, dangerous, admin, slow, fast, ... */
  cats: string[];
  args: RedisArgDef[];
  deprecated?: string;
  replacedBy?: string;
}
