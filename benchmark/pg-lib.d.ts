// pg's exports map exposes ./lib/* but DefinitelyTyped ships no declarations
// for the deep imports. The stack probe patches these prototypes directly, so
// re-export the matching classes from `@types/pg`.
declare module 'pg/lib/connection.js' {
  import { Connection } from 'pg';
  export default Connection;
}

declare module 'pg/lib/result.js' {
  import { Result } from 'pg';
  export default Result;
}
