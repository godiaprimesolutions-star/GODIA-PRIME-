-- GODIA PRIME CONNECT
-- Migration 0003: Products and Shopping Orders

PRAGMA foreign_keys = ON;

-- 1. PRODUCT CATALOGUE
CREATE TABLE IF NOT EXISTS gpce_products (
    id TEXT PRIMARY KEY,
    seller_user_id TEXT,
    product_name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    image_url TEXT,
    price INTEGER NOT NULL CHECK (price >= 0),
    currency TEXT NOT NULL DEFAULT 'KES',
    stock_quantity INTEGER NOT NULL DEFAULT 0
        CHECK (stock_quantity >= 0),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (seller_user_id)
        REFERENCES gpce_users(id)
        ON DELETE SET NULL
);

-- 2. CUSTOMER SHOPPING CART
CREATE TABLE IF NOT EXISTS gpce_cart_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)
        REFERENCES gpce_users(id)
        ON DELETE CASCADE,
    FOREIGN KEY (product_id)
        REFERENCES gpce_products(id)
        ON DELETE CASCADE,
    UNIQUE(user_id, product_id)
);

-- 3. CUSTOMER ORDERS
CREATE TABLE IF NOT EXISTS gpce_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    order_number TEXT NOT NULL UNIQUE,
    total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
    currency TEXT NOT NULL DEFAULT 'KES',
    status TEXT NOT NULL DEFAULT 'PENDING',
    payment_id TEXT,
    delivery_name TEXT,
    delivery_phone TEXT,
    delivery_address TEXT,
    delivery_county TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)
        REFERENCES gpce_users(id)
        ON DELETE SET NULL,
    FOREIGN KEY (payment_id)
        REFERENCES gpce_payments(id)
        ON DELETE SET NULL
);

-- 4. INDIVIDUAL PRODUCTS IN EACH ORDER
CREATE TABLE IF NOT EXISTS gpce_order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
    subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id)
        REFERENCES gpce_orders(id)
        ON DELETE CASCADE,
    FOREIGN KEY (product_id)
        REFERENCES gpce_products(id)
        ON DELETE SET NULL
);

-- 5. DATABASE INDEXES
CREATE INDEX IF NOT EXISTS idx_gpce_products_seller
ON gpce_products(seller_user_id);

CREATE INDEX IF NOT EXISTS idx_gpce_products_category
ON gpce_products(category);

CREATE INDEX IF NOT EXISTS idx_gpce_products_status
ON gpce_products(status);

CREATE INDEX IF NOT EXISTS idx_gpce_cart_user
ON gpce_cart_items(user_id);

CREATE INDEX IF NOT EXISTS idx_gpce_orders_user
ON gpce_orders(user_id);

CREATE INDEX IF NOT EXISTS idx_gpce_orders_status
ON gpce_orders(status);

CREATE INDEX IF NOT EXISTS idx_gpce_orders_payment
ON gpce_orders(payment_id);

CREATE INDEX IF NOT EXISTS idx_gpce_order_items_order
ON gpce_order_items(order_id);

CREATE INDEX IF NOT EXISTS idx_gpce_order_items_product
ON gpce_order_items(product_id);
