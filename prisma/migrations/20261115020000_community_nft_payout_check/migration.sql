-- Enforce that CommunityNFT can only be marked payout-routable when scriptType is verified as P2PKH
UPDATE "community_nfts"
SET "isPayoutRoutable" = false
WHERE "scriptType" <> 'P2PKH' AND "isPayoutRoutable" = true;

ALTER TABLE "community_nfts"
  DROP CONSTRAINT IF EXISTS "community_nfts_payout_routable_requires_p2pkh_check";

ALTER TABLE "community_nfts"
  ADD CONSTRAINT "community_nfts_payout_routable_requires_p2pkh_check"
  CHECK ("isPayoutRoutable" = false OR "scriptType" = 'P2PKH');
