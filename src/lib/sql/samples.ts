/** Sample data shared by the SQL lab tabs. Plain strings: safe to render during SSR. */

export const SHOP_DDL = `CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(120) UNIQUE,
  country CHAR(2) DEFAULT 'PL',
  created_at TIMESTAMP
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  title TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  stock INTEGER DEFAULT 0
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status VARCHAR(16) NOT NULL DEFAULT 'new',
  placed_at TIMESTAMP,
  total NUMERIC(10, 2)
);

CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, product_id)
);
`;

export const BLOG_DDL = `CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  bio TEXT
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users (id),
  body TEXT NOT NULL
);
`;

export const HR_DDL = `CREATE TABLE departments (
  id INT NOT NULL PRIMARY KEY,
  name NVARCHAR(60) NOT NULL
);

CREATE TABLE employees (
  id INT IDENTITY(1,1) PRIMARY KEY,
  full_name NVARCHAR(100) NOT NULL,
  department_id INT NOT NULL REFERENCES departments (id),
  manager_id INT NULL REFERENCES employees (id),
  salary DECIMAL(12, 2),
  hired_on DATE
);
`;

export interface SampleSchema {
  id: string;
  label: string;
  dialect: string;
  ddl: string;
}

export const SAMPLE_SCHEMAS: SampleSchema[] = [
  { id: "shop", label: "Shop (customers, orders, products)", dialect: "sqlite", ddl: SHOP_DDL },
  { id: "blog", label: "Blog (users, posts, comments)", dialect: "postgres", ddl: BLOG_DDL },
  { id: "hr", label: "HR (employees, departments)", dialect: "tsql", ddl: HR_DDL },
];

/** A small populated SQLite database for the Run tab. */
export const SAMPLE_RUN_SQL = `${SHOP_DDL}
INSERT INTO customers (id, name, email, country, created_at) VALUES
  (1, 'Ada Kowalska', 'ada@example.com', 'PL', '2025-01-12'),
  (2, 'Bruno Meyer', 'bruno@example.com', 'DE', '2025-02-03'),
  (3, 'Chloé Martin', 'chloe@example.com', 'FR', '2025-02-20'),
  (4, 'Dmitri Ivanov', NULL, 'PL', '2025-03-01');
INSERT INTO products (id, sku, title, price, stock) VALUES
  (1, 'KB-01', 'Mechanical keyboard', 129.00, 14),
  (2, 'MS-02', 'Wireless mouse', 49.50, 40),
  (3, 'MN-27', '27-inch monitor', 329.99, 6),
  (4, 'CB-05', 'USB-C cable', 9.90, 200);
INSERT INTO orders (id, customer_id, status, placed_at, total) VALUES
  (1, 1, 'paid', '2025-03-02', 178.50),
  (2, 1, 'shipped', '2025-03-15', 329.99),
  (3, 2, 'new', '2025-03-16', 19.80),
  (4, 3, 'paid', '2025-03-18', 129.00);
INSERT INTO order_items (order_id, product_id, quantity) VALUES
  (1, 1, 1), (1, 2, 1), (2, 3, 1), (3, 4, 2), (4, 1, 1);
`;

export const RUN_EXAMPLE_QUERY = `SELECT c.name, COUNT(o.id) AS orders, ROUND(SUM(o.total), 2) AS revenue
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id
ORDER BY revenue DESC;`;
