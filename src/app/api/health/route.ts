import { NextResponse } from 'next/server';
import { parseAppEnv } from '@/lib/config/env';

export async function GET() {
  const env = parseAppEnv();

  return NextResponse.json({
    status: 'ok',
    phase: 2,
    appMode: env.APP_MODE,
    bsvNetwork: env.BSV_NETWORK,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    ownerShareBps: env.OWNER_SHARE_BPS,
    platformShareBps: env.PLATFORM_SHARE_BPS,
    activityFeeSats: env.ACTIVITY_FEE_SATS,
    ownershipConfirmationsRequired: env.OWNERSHIP_CONFIRMATIONS_REQUIRED,
    paymentConfirmationsRequired: env.PAYMENT_CONFIRMATIONS_REQUIRED,
  });
}
