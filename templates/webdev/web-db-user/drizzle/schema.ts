import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  /** External auth subject. For Supabase Auth this should map to auth.users.id. */
  openId: varchar("openId", { length: 128 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

/**
 * Durable inventory foundation for product apps such as resale scanners.
 * Extend these tables instead of storing inventory, scans, orders, or photos in localStorage.
 */
export const inventoryItems = mysqlTable("inventory_items", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 128 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  sku: varchar("sku", { length: 128 }),
  source: varchar("source", { length: 128 }),
  condition: varchar("condition", { length: 128 }),
  status: mysqlEnum("status", ["draft", "active", "listed", "sold", "archived"]).default("draft").notNull(),
  purchasePriceCents: int("purchasePriceCents").default(0).notNull(),
  expectedSalePriceCents: int("expectedSalePriceCents").default(0).notNull(),
  shippingCostCents: int("shippingCostCents").default(0).notNull(),
  platformFeeCents: int("platformFeeCents").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const inventoryPhotos = mysqlTable("inventory_photos", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 128 }).notNull(),
  inventoryItemId: int("inventoryItemId"),
  bucket: varchar("bucket", { length: 128 }).default("inventory-photos").notNull(),
  storagePath: varchar("storagePath", { length: 512 }).notNull(),
  publicUrl: text("publicUrl"),
  contentType: varchar("contentType", { length: 128 }),
  sizeBytes: int("sizeBytes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const scans = mysqlTable("scans", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 128 }).notNull(),
  inventoryItemId: int("inventoryItemId"),
  query: text("query"),
  resultJson: text("resultJson"),
  confidence: int("confidence"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const listings = mysqlTable("listings", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 128 }).notNull(),
  inventoryItemId: int("inventoryItemId").notNull(),
  channel: varchar("channel", { length: 128 }),
  externalListingId: varchar("externalListingId", { length: 255 }),
  status: mysqlEnum("status", ["draft", "listed", "paused", "sold", "ended"]).default("draft").notNull(),
  listedPriceCents: int("listedPriceCents").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const orders = mysqlTable("orders", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 128 }).notNull(),
  inventoryItemId: int("inventoryItemId"),
  listingId: int("listingId"),
  status: mysqlEnum("status", ["pending", "paid", "shipped", "delivered", "cancelled", "refunded"]).default("pending").notNull(),
  salePriceCents: int("salePriceCents").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const shipments = mysqlTable("shipments", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 128 }).notNull(),
  orderId: int("orderId"),
  carrier: varchar("carrier", { length: 128 }),
  trackingNumber: varchar("trackingNumber", { length: 255 }),
  status: varchar("status", { length: 128 }),
  shippedAt: timestamp("shippedAt"),
  deliveredAt: timestamp("deliveredAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InsertInventoryItem = typeof inventoryItems.$inferInsert;
export type InventoryPhoto = typeof inventoryPhotos.$inferSelect;
export type InsertInventoryPhoto = typeof inventoryPhotos.$inferInsert;
export type Scan = typeof scans.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
