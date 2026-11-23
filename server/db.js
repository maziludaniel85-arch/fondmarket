// Conexiunea MySQL și schema. Tabelele se creează automat la prima pornire.
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  charset: 'utf8mb4',
  dateStrings: true,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(190) NOT NULL UNIQUE,
    pass VARCHAR(100) NOT NULL,
    role ENUM('admin','beneficiar') NOT NULL DEFAULT 'beneficiar',
    name VARCHAR(190) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS firms (
    user_id INT PRIMARY KEY,
    cui VARCHAR(20) NOT NULL DEFAULT '',
    name VARCHAR(190) NOT NULL DEFAULT '',
    addr VARCHAR(255) NOT NULL DEFAULT '',
    reg VARCHAR(40) NOT NULL DEFAULT '',
    email VARCHAR(190) NOT NULL DEFAULT '',
    person VARCHAR(190) NOT NULL DEFAULT '',
    project VARCHAR(255) NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS project_state (
    user_id INT PRIMARY KEY,
    state JSON NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS settings (
    k VARCHAR(40) PRIMARY KEY,
    v JSON NOT NULL
  ) CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS orders (
    no VARCHAR(20) PRIMARY KEY,
    user_id INT NOT NULL,
    client VARCHAR(190) NOT NULL,
    cui VARCHAR(20) NOT NULL,
    pkg VARCHAR(60) NOT NULL,
    pkg_key VARCHAR(20) NOT NULL,
    lot VARCHAR(40) NOT NULL DEFAULT '',
    lines_json JSON NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    vat DECIMAL(10,2) NOT NULL,
    tot DECIMAL(10,2) NOT NULL,
    method ENUM('card','op') NOT NULL,
    status ENUM('așteaptă plata','plătită','anulată') NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS suppliers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(190) NOT NULL,
    cui VARCHAR(20) NOT NULL DEFAULT '',
    email VARCHAR(190) NOT NULL,
    cats JSON NOT NULL,
    status ENUM('invitat','activ','inactiv') NOT NULL DEFAULT 'invitat',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS rfqs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    items JSON NOT NULL,
    deadline DATE NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS rfq_sends (
    token CHAR(32) PRIMARY KEY,
    rfq_id INT NOT NULL,
    supplier_id INT NOT NULL,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opened_at DATETIME NULL,
    answered_at DATETIME NULL,
    price DECIMAL(12,2) NULL,
    note TEXT NULL,
    file MEDIUMBLOB NULL,
    file_name VARCHAR(190) NULL,
    FOREIGN KEY (rfq_id) REFERENCES rfqs(id) ON DELETE CASCADE,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
  ) CHARSET=utf8mb4`,
];

const DEFAULT_PRICES = {
  dosar: 149,
  proiect: 1190,
  extra: { ver: 79, exp: 490, cert: 290 },
  vat: 0.21,
};

async function migrate() {
  for (const q of SCHEMA) await pool.query(q);
  await pool.query('INSERT IGNORE INTO settings (k, v) VALUES (?, ?)', ['prices', JSON.stringify(DEFAULT_PRICES)]);
}

async function one(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}
async function all(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function run(sql, params) {
  const [res] = await pool.query(sql, params);
  return res;
}
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

module.exports = { pool, migrate, one, all, run, json, DEFAULT_PRICES };
