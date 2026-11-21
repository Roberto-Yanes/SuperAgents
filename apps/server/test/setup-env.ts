process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/ega_test";
process.env.SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123";
process.env.LOG_LEVEL = "silent";
process.env.RATE_LIMIT_MAX = "10000";
