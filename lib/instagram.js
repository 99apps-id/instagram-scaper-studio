/**
 * Instagram Scraping Engine — Public Web API (no auth required for basic profile)
 * Rate-limit aware, session-aware, robust error handling.
 */

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const INSTAGRAM_APP_ID = '936619743392459'; // Official Instagram Web App ID

// Rate limit tracking per session
const rateLimitState = new Map(); // sessionId -> { count, resetAt, challenged }

function getRateLimitKey(session) {
  return session.sessionId || 'anonymous';
}

function checkRateLimit(session, maxRequests = 30, windowMs = 60000) {
  const key = getRateLimitKey(session);
  const now = Date.now();
  const state = rateLimitState.get(key) || { count: 0, resetAt: now + windowMs, challenged: false };
  
  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + windowMs;
    state.challenged = false;
  }
  
  state.count++;
  rateLimitState.set(key, state);
  
  return {
    allowed: state.count <= maxRequests && !state.challenged,
    remaining: Math.max(0, maxRequests - state.count),
    retryAfter: state.challenged ? state.resetAt - now : 0
  };
}

function markChallenged(session) {
  const key = getRateLimitKey(session);
  const state = rateLimitState.get(key) || { count: 0, resetAt: Date.now() + 60000, challenged: false };
  state.challenged = true;
  state.resetAt = Date.now() + 300000; // 5 min cooldown after challenge
  rateLimitState.set(key, state);
}

function buildHeaders(session, referer) {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    'X-IG-App-ID': INSTAGRAM_APP_ID,
    'Accept': '*/*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': referer || 'https://www.instagram.com/',
  };
  
  if (session.sessionId) {
    const cookieParts = [];
    if (session.sessionId) cookieParts.push(`sessionid=${session.sessionId}`);
    if (session.csrfToken) cookieParts.push(`csrftoken=${session.csrfToken}`);
    if (session.userId) cookieParts.push(`ds_user_id=${session.userId}`);
    headers['Cookie'] = cookieParts.join('; ');
  }
  
  return headers;
}

async function fetchWithRetry(url, options, retries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      
      // Rate limited
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      // Challenge required (login wall)
      if (res.status === 400 || res.status === 403) {
        const text = await res.text();
        if (text.includes('challenge_required') || text.includes('login_required')) {
          throw Object.assign(new Error('CHALLENGE_REQUIRED'), { status: res.status, challenge: true });
        }
      }
      
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        // Network error, retry
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Extract phone number from text (Indonesian format)
 */
export function extractPhoneNumber(text) {
  if (!text || typeof text !== 'string') return '';
  
  // Indonesian patterns: +62, 08, 02x (landline)
  const patterns = [
    /(\+62\s?[2-9]\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{3,5})/g,  // +62 xx xxxx xxxx
    /(08\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{3,5})/g,            // 08xx xxxx xxxx
    /(02\d{1}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/g,               // 02x xxxx xxxx (landline)
    /(\(02\d{1}\)[\s.-]?\d{3,4}[\s.-]?\d{3,4})/g,           // (02x) xxxx xxxx
  ];
  
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      // Clean: keep only digits, normalize to 62 format
      let clean = matches[0].replace(/[^\d]/g, '');
      if (clean.startsWith('0')) clean = '62' + clean.slice(1);
      if (clean.startsWith('62') && clean.length >= 10 && clean.length <= 13) {
        return clean;
      }
    }
  }
  
  return '';
}

/**
 * Extract email from text
 */
export function extractEmail(text) {
  if (!text || typeof text !== 'string') return '';
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : '';
}

/**
 * Calculate engagement rate from posts
 */
export function calculateEngagementRate(posts, followerCount) {
  if (!Array.isArray(posts) || posts.length === 0 || !followerCount || followerCount <= 0) {
    return { er: 0, avgLikes: 0, avgComments: 0, avgViews: 0 };
  }
  
  let totalLikes = 0;
  let totalComments = 0;
  let totalViews = 0;
  let videoCount = 0;
  
  posts.forEach(p => {
    totalLikes += (p.likeCount || 0);
    totalComments += (p.commentCount || 0);
    if (p.isVideo && p.viewCount) {
      totalViews += p.viewCount;
      videoCount++;
    }
  });
  
  const avgLikes = Math.round(totalLikes / posts.length);
  const avgComments = Math.round(totalComments / posts.length);
  const avgViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;
  const er = Number((((avgLikes + avgComments) / followerCount) * 100).toFixed(2));
  
  return { er, avgLikes, avgComments, avgViews };
}

/**
 * Search Instagram accounts by keyword/hashtag
 * Uses Instagram Web Topsearch API
 */
export async function searchInstagramAccounts(query, session = {}) {
  const encQuery = encodeURIComponent(String(query || '').trim());
  const url = `https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encQuery}&include_reel=false`;
  
  const rl = checkRateLimit(session);
  if (!rl.allowed) {
    throw Object.assign(new Error('Rate limit exceeded. Please wait.'), { status: 429, retryAfter: rl.retryAfter });
  }
  
  const headers = buildHeaders(session, 'https://www.instagram.com/');
  
  const res = await fetchWithRetry(url, { headers });
  
  if (!res.ok) {
    if (res.status === 429) markChallenged(session);
    throw Object.assign(new Error(`Search failed HTTP ${res.status}`), { status: res.status });
  }
  
  const data = await res.json();
  
  const accounts = [];
  for (const item of (data.users || [])) {
    const u = item.user;
    if (u && u.username) {
      accounts.push({
        pk: u.pk,
        username: u.username,
        fullName: u.full_name || '',
        isVerified: Boolean(u.is_verified),
        profilePicUrl: u.profile_pic_url || '',
        isPrivate: Boolean(u.is_private),
        followerCount: u.follower_count || 0,
      });
    }
  }
  
  return accounts;
}

/**
 * Fetch detailed Instagram profile + recent posts for lead analysis
 */
export async function fetchInstagramProfile(username, session = {}) {
  const cleanUsername = String(username || '').replace(/^@/, '').trim();
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanUsername)}`;
  
  const rl = checkRateLimit(session);
  if (!rl.allowed) {
    throw Object.assign(new Error('Rate limit exceeded. Please wait.'), { status: 429, retryAfter: rl.retryAfter });
  }
  
  const headers = buildHeaders(session, `https://www.instagram.com/${cleanUsername}/`);
  
  const res = await fetchWithRetry(url, { headers });
  
  if (!res.ok) {
    if (res.status === 429) markChallenged(session);
    if (res.status === 404) throw Object.assign(new Error('Profile not found'), { status: 404 });
    throw Object.assign(new Error(`Profile fetch failed HTTP ${res.status}`), { status: res.status });
  }
  
  const json = await res.json();
  const u = json?.data?.user;
  if (!u) throw new Error('Data profil tidak ditemukan');
  
  // Basic info
  const bio = u.biography || '';
  const businessPhone = u.business_phone_number || extractPhoneNumber(bio);
  const businessEmail = u.business_email || extractEmail(bio);
  const followerCount = u.edge_followed_by?.count || 0;
  const followingCount = u.edge_follow?.count || 0;
  const totalPosts = u.edge_owner_to_timeline_media?.count || 0;
  const category = u.category_name || u.business_category_name || 'Bisnis / Kreator';
  
  // Analyze recent posts (up to 12)
  const posts = [];
  const edges = u.edge_owner_to_timeline_media?.edges || [];
  const hashtagsMap = {};
  let totalLikes = 0;
  let totalComments = 0;
  let totalViews = 0;
  let videoCount = 0;
  
  for (const edge of edges.slice(0, 12)) {
    const node = edge.node;
    if (!node) continue;
    
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const likes = node.edge_liked_by?.count || 0;
    const comments = node.edge_media_to_comment?.count || 0;
    const isVideo = node.is_video === true;
    const viewCount = isVideo ? (node.video_view_count || 0) : 0;
    
    totalLikes += likes;
    totalComments += comments;
    if (isVideo) { totalViews += viewCount; videoCount++; }
    
    // Extract hashtags from caption
    const foundTags = caption.match(/#[a-zA-Z0-9_]+/g) || [];
    foundTags.forEach(t => {
      const tagLower = t.toLowerCase();
      hashtagsMap[tagLower] = (hashtagsMap[tagLower] || 0) + 1;
    });
    
    posts.push({
      id: node.id,
      shortcode: node.shortcode,
      postUrl: `https://www.instagram.com/p/${node.shortcode}/`,
      caption: caption.slice(0, 300),
      likeCount: likes,
      commentCount: comments,
      viewCount,
      isVideo,
      takenAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
      displayUrl: node.display_url || node.thumbnail_src || '',
    });
  }
  
  const { er, avgLikes, avgComments, avgViews } = calculateEngagementRate(posts, followerCount);
  
  const topHashtags = Object.entries(hashtagsMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(entry => entry[0]);
  
  return {
    username: u.username,
    fullName: u.full_name || '',
    biography: bio,
    category,
    phone: businessPhone,
    email: businessEmail,
    externalUrl: u.external_url || '',
    followerCount,
    followingCount,
    totalPosts,
    isVerified: Boolean(u.is_verified),
    isBusinessAccount: Boolean(u.is_business_account),
    engagementRate: er,
    avgLikes,
    avgComments,
    avgViews,
    topHashtags,
    profileUrl: `https://www.instagram.com/${u.username}/`,
    profilePicUrl: u.profile_pic_url_hd || u.profile_pic_url || '',
    recentPosts: posts,
  };
}

/**
 * Validate session by fetching own profile
 */
export async function validateSession(session) {
  if (!session.sessionId) return { valid: false, reason: 'NO_SESSION' };
  
  try {
    const url = 'https://www.instagram.com/api/v1/accounts/edit/web_form_data/';
    const headers = buildHeaders(session, 'https://www.instagram.com/');
    headers['X-CSRFToken'] = session.csrfToken || '';
    headers['X-Requested-With'] = 'XMLHttpRequest';
    
    const res = await fetch(url, { headers, method: 'GET' });
    
    if (res.ok) return { valid: true };
    if (res.status === 403 || res.status === 401) return { valid: false, reason: 'SESSION_EXPIRED' };
    return { valid: false, reason: `HTTP_${res.status}` };
  } catch {
    return { valid: false, reason: 'NETWORK_ERROR' };
  }
}

/**
 * Get rate limit status for debugging
 */
export function getRateLimitStatus(session) {
  const key = getRateLimitKey(session);
  return rateLimitState.get(key) || { count: 0, resetAt: Date.now() + 60000, challenged: false };
}