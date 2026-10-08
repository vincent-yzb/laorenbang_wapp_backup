-- Additive migration only. Run through the normal reviewed database release process.
ALTER TABLE "users" ADD COLUMN "wechatOpenId" TEXT;
ALTER TABLE "angels" ADD COLUMN "wechatOpenId" TEXT;
CREATE UNIQUE INDEX "users_wechatOpenId_key" ON "users"("wechatOpenId");
CREATE UNIQUE INDEX "angels_wechatOpenId_key" ON "angels"("wechatOpenId");
