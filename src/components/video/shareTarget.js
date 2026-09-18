import { ensureCloudVideoId, isCloudVideoId } from '../../lib/cloud-videos';
import { getBrowserSupabase } from '../../lib/supabase/browser';

// Can this clip be shared, and under which cloud row?
//
// The local flags were a GUESS, and it was wrong in both directions: a clip
// uploaded before the local "original uploaded" mark existed carries none of
// them, and cloudId is only attached once the day's cloud list has merged in —
// so the sheet said "upload this clip first" for clips that were already in the
// cloud. Ask the server instead: resolve the row (idempotent — dedupes by
// external_id) and let the playback endpoint say whether a rendition exists.
async function resolveShareTarget(video){
  let cloudId = video.cloudId || (isCloudVideoId(video.id) ? video.id : null);
  if(!cloudId){
    try{
      const supabase = getBrowserSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if(!user) return { error: "You are signed out. Sign in and try again." };
      cloudId = await ensureCloudVideoId({ userId: user.id, video, sessionDate: video.sessionDate });
    }catch(e){ return { error: e?.message || 'could not find this clip in the cloud' }; }
  }
  if(!cloudId) return { error: 'this clip has no cloud row yet — check your team membership in Admin' };
  try{
    const res = await fetch(`/api/videos/${encodeURIComponent(cloudId)}/url?prefer=proxy`, { cache: 'no-store' });
    if(res.status === 404) return { cloudId, playable: false };          // genuinely nothing uploaded
    if(!res.ok) return { cloudId, playable: false, error: `could not check this clip (HTTP ${res.status})` };
    return { cloudId, playable: true };                                   // a rendition exists (or is encoding)
  }catch{ return { cloudId, playable: false, error: 'could not reach the server' }; }
}

export { resolveShareTarget };