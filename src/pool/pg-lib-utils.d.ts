// pg's exports map exposes ./lib/* but DefinitelyTyped ships no declarations
// for the deep imports. FastQuery reuses the stock value mapper so parameter
// serialization is byte-identical to pg's own Query path.
declare module 'pg/lib/utils.js' {
  const utils: {
    prepareValue: (value: unknown) => unknown;
  };
  export default utils;
}
