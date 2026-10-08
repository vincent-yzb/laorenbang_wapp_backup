-- Additive identity scope only. Legacy NULL values are deliberately not guessed
-- or backfilled: an OpenID alone does not prove ownership in the current AppID.
ALTER TABLE "users" ADD COLUMN "wechatAppId" TEXT;
ALTER TABLE "angels" ADD COLUMN "wechatAppId" TEXT;
