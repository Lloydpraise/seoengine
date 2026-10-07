// Tiny JSON file store. One process, atomic writes, debounced saves.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file = path.join(__dirname, '..', 'data', 'store.json')) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = { products: {}, profiles: {}, knowledge: {}, settings: {}, meta: { seq: 0 } };
    if (fs.existsSync(file)) {
      try {
        Object.assign(this.db, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (e) {
        const bak = `${file}.corrupt-${Date.now()}`;
        fs.copyFileSync(file, bak);
        console.error(`store.json could not be read (${e.message}). Backed up to ${bak}`);
      }
    }
    this._t = null;
  }
  id(prefix) {
    this.db.meta.seq++;
    return prefix + Date.now().toString(36) + this.db.meta.seq.toString(36);
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this._t);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }
}
module.exports = { Store };
