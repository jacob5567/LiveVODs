import { GuideGrid } from '@/components/GuideGrid';
import { twitchEmbedParents } from '@/lib/config';
import { loadGuide } from '@/lib/guide';

// The guide is time-sensitive; never serve it from the static cache.
export const dynamic = 'force-dynamic';

export default async function Page() {
  return <GuideGrid guide={loadGuide()} extraParents={twitchEmbedParents()} />;
}
