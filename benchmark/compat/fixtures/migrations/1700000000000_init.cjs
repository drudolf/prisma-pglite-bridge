/** Minimal node-pg-migrate fixture: one table up, dropped on down. */
exports.up = (pgm) => {
  pgm.createTable('compat_migrate_items', {
    id: 'id',
    label: { type: 'text', notNull: true },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('compat_migrate_items');
};
