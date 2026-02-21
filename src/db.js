const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 2;
const MAX_PAGE_SIZE = 30;
const REACTIONS = ["like", "heart", "fire", "clap"];
const ROLES = ["user", "moderator", "admin"];
const USER_STATUS = ["active", "suspended", "banned"];
const REPORT_STATUS = ["open", "in_review", "resolved", "dismissed"];
const REPORT_TARGETS = ["post", "comment", "user"];

const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "app.json");

const categorySeed = [
  {
    name: "Videography",
    slug: "videography",
    description: "Filmmaking, reels, edits, and camera movement.",
    sort_order: 1
  },
  {
    name: "Photography",
    slug: "photography",
    description: "Portraits, street, studio, and color grading.",
    sort_order: 2
  },
  {
    name: "Creators",
    slug: "creators",
    description: "Creator economy, growth, and production workflows.",
    sort_order: 3
  },
  {
    name: "Post-Production",
    slug: "post-production",
    description: "Editing, sound design, VFX, and finishing.",
    sort_order: 4
  },
  {
    name: "Gear",
    slug: "gear",
    description: "Cameras, lenses, lights, drones, and reviews.",
    sort_order: 5
  },
  {
    name: "Industry",
    slug: "industry",
    description: "Media business, agencies, and production trends.",
    sort_order: 6
  },
  {
    name: "Inspiration",
    slug: "inspiration",
    description: "Reference projects and visual storytelling ideas.",
    sort_order: 7
  }
];

function nowIso() {
  return new Date().toISOString();
}

function padId(value) {
  return String(Number(value) || 0).padStart(10, "0");
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeText(input) {
  return String(input || "").toLowerCase().trim();
}

function isRole(value) {
  return ROLES.includes(value);
}

function isUserStatus(value) {
  return USER_STATUS.includes(value);
}

function isReportStatus(value) {
  return REPORT_STATUS.includes(value);
}

function isReportTarget(value) {
  return REPORT_TARGETS.includes(value);
}

function isReaction(value) {
  return REACTIONS.includes(value);
}

function baseState() {
  return {
    schema_version: SCHEMA_VERSION,
    counters: {
      users: 0,
      categories: 0,
      posts: 0,
      likes: 0,
      comments: 0,
      tags: 0,
      bookmarks: 0,
      comment_reactions: 0,
      reports: 0,
      moderation_actions: 0
    },
    users: [],
    categories: [],
    posts: [],
    likes: [],
    comments: [],
    tags: [],
    post_tags: [],
    bookmarks: [],
    comment_reactions: [],
    reports: [],
    moderation_actions: [],
    search_index_meta: {
      last_rebuild_at: null
    }
  };
}

function ensureDataFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(baseState(), null, 2));
  }
}

function sanitizeState(raw) {
  const next = baseState();
  const source = raw && typeof raw === "object" ? raw : {};
  next.schema_version = Number(source.schema_version || 1);
  next.counters = { ...next.counters, ...(source.counters || {}) };
  next.users = Array.isArray(source.users) ? source.users : [];
  next.categories = Array.isArray(source.categories) ? source.categories : [];
  next.posts = Array.isArray(source.posts) ? source.posts : [];
  next.likes = Array.isArray(source.likes) ? source.likes : [];
  next.comments = Array.isArray(source.comments) ? source.comments : [];
  next.tags = Array.isArray(source.tags) ? source.tags : [];
  next.post_tags = Array.isArray(source.post_tags) ? source.post_tags : [];
  next.bookmarks = Array.isArray(source.bookmarks) ? source.bookmarks : [];
  next.comment_reactions = Array.isArray(source.comment_reactions) ? source.comment_reactions : [];
  next.reports = Array.isArray(source.reports) ? source.reports : [];
  next.moderation_actions = Array.isArray(source.moderation_actions) ? source.moderation_actions : [];
  next.search_index_meta = {
    ...next.search_index_meta,
    ...(source.search_index_meta && typeof source.search_index_meta === "object"
      ? source.search_index_meta
      : {})
  };
  return next;
}

function maxId(items) {
  let max = 0;
  for (const item of items) {
    if (item && typeof item.id === "number" && item.id > max) {
      max = item.id;
    }
  }
  return max;
}

function toInt(value) {
  const asNum = Number(value);
  return Number.isInteger(asNum) ? asNum : 0;
}

function hydrateCounters(current) {
  current.counters.users = Math.max(toInt(current.counters.users), maxId(current.users));
  current.counters.categories = Math.max(toInt(current.counters.categories), maxId(current.categories));
  current.counters.posts = Math.max(toInt(current.counters.posts), maxId(current.posts));
  current.counters.likes = Math.max(toInt(current.counters.likes), maxId(current.likes));
  current.counters.comments = Math.max(toInt(current.counters.comments), maxId(current.comments));
  current.counters.tags = Math.max(toInt(current.counters.tags), maxId(current.tags));
  current.counters.bookmarks = Math.max(toInt(current.counters.bookmarks), maxId(current.bookmarks));
  current.counters.comment_reactions = Math.max(
    toInt(current.counters.comment_reactions),
    maxId(current.comment_reactions)
  );
  current.counters.reports = Math.max(toInt(current.counters.reports), maxId(current.reports));
  current.counters.moderation_actions = Math.max(
    toInt(current.counters.moderation_actions),
    maxId(current.moderation_actions)
  );
}

let state = baseState();

const writeQueue = [];
let isWriting = false;

function writeAtomic(payload) {
  const tempPath = `${dbPath}.tmp`;
  fs.writeFileSync(tempPath, payload);
  fs.renameSync(tempPath, dbPath);
}

function flushWriteQueue() {
  if (isWriting) return;
  isWriting = true;
  while (writeQueue.length > 0) {
    writeAtomic(writeQueue.shift());
  }
  isWriting = false;
}

function enqueueWrite() {
  writeQueue.push(JSON.stringify(state, null, 2));
  flushWriteQueue();
}

function nextId(entity) {
  state.counters[entity] = (toInt(state.counters[entity]) || 0) + 1;
  return state.counters[entity];
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    bio: user.bio || "",
    avatar_url: user.avatar_url || "",
    created_at: user.created_at,
    role: user.role || "user",
    status: user.status || "active",
    email_verified: Boolean(user.email_verified)
  };
}

function isModeratorRole(role) {
  return role === "moderator" || role === "admin";
}

function isAdminRole(role) {
  return role === "admin";
}

function canUserModerate(user) {
  return Boolean(user && isModeratorRole(user.role));
}

function canUserAdmin(user) {
  return Boolean(user && isAdminRole(user.role));
}

function canViewHidden({ viewer, authorId }) {
  if (!viewer) return false;
  if (viewer.id === authorId) return true;
  return isModeratorRole(viewer.role);
}

function summarize(text, maxLength = 220) {
  if (!text) return "";
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}...`;
}

function computeReadingTime(markdownBody) {
  const words = String(markdownBody || "")
    .replace(/[`*_#>\-\[\]\(\)!]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function ensureCategoriesSeeded() {
  if (state.categories.length > 0) return;
  for (const item of categorySeed) {
    state.categories.push({
      id: nextId("categories"),
      name: item.name,
      slug: item.slug,
      description: item.description,
      sort_order: item.sort_order
    });
  }
}

function migrateState() {
  const hasAdmin = state.users.some((user) => user.role === "admin");
  for (let i = 0; i < state.users.length; i += 1) {
    const user = state.users[i];
    user.id = toInt(user.id);
    user.username = String(user.username || "").trim();
    user.email = normalizeText(user.email || "");
    user.password_hash = String(user.password_hash || "");
    user.bio = String(user.bio || "");
    user.avatar_url = String(user.avatar_url || "");
    user.created_at = user.created_at || nowIso();
    user.role = isRole(user.role) ? user.role : "user";
    user.status = isUserStatus(user.status) ? user.status : "active";
    if (typeof user.email_verified !== "boolean") {
      user.email_verified = true;
    }
    user.verification_token_hash = user.verification_token_hash || null;
    user.verification_expires_at = user.verification_expires_at || null;
    user.reset_token_hash = user.reset_token_hash || null;
    user.reset_expires_at = user.reset_expires_at || null;
    if (!hasAdmin && i === 0) {
      user.role = "admin";
    }
  }

  const categorySeen = new Set();
  state.categories = state.categories
    .map((category, index) => ({
      id: toInt(category.id),
      name: String(category.name || `Category ${index + 1}`),
      slug: slugify(category.slug || category.name || `category-${index + 1}`),
      description: String(category.description || ""),
      sort_order: Number(category.sort_order || index + 1)
    }))
    .filter((category) => {
      if (!category.slug || categorySeen.has(category.slug)) return false;
      categorySeen.add(category.slug);
      return true;
    });

  for (const post of state.posts) {
    post.id = toInt(post.id);
    post.user_id = toInt(post.user_id);
    post.category_id = toInt(post.category_id);
    post.title = String(post.title || "").trim();
    const oldBody = String(post.body || "");
    post.markdown_body = String(post.markdown_body || oldBody || "");
    post.rendered_html = String(post.rendered_html || "");
    post.excerpt = String(post.excerpt || summarize(post.markdown_body));
    post.reading_time_minutes = Number(post.reading_time_minutes || computeReadingTime(post.markdown_body));
    post.media_url = String(post.media_url || "");
    post.media_type = ["none", "image", "video"].includes(post.media_type) ? post.media_type : "none";
    post.is_hidden = Boolean(post.is_hidden);
    post.hidden_reason = String(post.hidden_reason || "");
    post.created_at = post.created_at || nowIso();
  }

  state.likes = state.likes
    .map((like) => ({
      id: toInt(like.id),
      user_id: toInt(like.user_id),
      post_id: toInt(like.post_id),
      created_at: like.created_at || nowIso()
    }))
    .filter((like) => like.id > 0 && like.user_id > 0 && like.post_id > 0);

  const commentSeen = new Set();
  for (const comment of state.comments) {
    comment.id = toInt(comment.id);
    comment.user_id = toInt(comment.user_id);
    comment.post_id = toInt(comment.post_id);
    comment.parent_comment_id = comment.parent_comment_id ? toInt(comment.parent_comment_id) : null;
    comment.depth = Number.isInteger(comment.depth) ? comment.depth : 0;
    comment.path = String(comment.path || "");
    comment.body = String(comment.body || "");
    comment.is_hidden = Boolean(comment.is_hidden);
    comment.hidden_reason = String(comment.hidden_reason || "");
    comment.created_at = comment.created_at || nowIso();
    commentSeen.add(comment.id);
  }
  for (const comment of state.comments) {
    if (comment.parent_comment_id && !commentSeen.has(comment.parent_comment_id)) {
      comment.parent_comment_id = null;
      comment.depth = 0;
    }
    if (!comment.path) {
      comment.path = comment.parent_comment_id
        ? `${padId(comment.parent_comment_id)}.${padId(comment.id)}`
        : padId(comment.id);
    }
  }

  const tagSeen = new Set();
  state.tags = state.tags
    .map((tag) => {
      const name = String(tag.name || "").trim();
      const slug = slugify(tag.slug || name);
      return {
        id: toInt(tag.id),
        name: name || slug,
        slug,
        created_at: tag.created_at || nowIso()
      };
    })
    .filter((tag) => {
      if (!tag.id || !tag.slug || tagSeen.has(tag.slug)) return false;
      tagSeen.add(tag.slug);
      return true;
    });

  state.post_tags = state.post_tags
    .map((relation) => ({
      post_id: toInt(relation.post_id),
      tag_id: toInt(relation.tag_id)
    }))
    .filter((relation) => relation.post_id > 0 && relation.tag_id > 0);

  state.bookmarks = state.bookmarks
    .map((bookmark) => ({
      id: toInt(bookmark.id),
      user_id: toInt(bookmark.user_id),
      post_id: toInt(bookmark.post_id),
      created_at: bookmark.created_at || nowIso()
    }))
    .filter((bookmark) => bookmark.id > 0 && bookmark.user_id > 0 && bookmark.post_id > 0);

  state.comment_reactions = state.comment_reactions
    .map((reaction) => ({
      id: toInt(reaction.id),
      comment_id: toInt(reaction.comment_id),
      user_id: toInt(reaction.user_id),
      reaction_type: isReaction(reaction.reaction_type) ? reaction.reaction_type : "like",
      created_at: reaction.created_at || nowIso()
    }))
    .filter((reaction) => reaction.id > 0 && reaction.comment_id > 0 && reaction.user_id > 0);

  state.reports = state.reports
    .map((report) => ({
      id: toInt(report.id),
      reporter_user_id: toInt(report.reporter_user_id),
      target_type: isReportTarget(report.target_type) ? report.target_type : "post",
      target_id: toInt(report.target_id),
      reason_code: String(report.reason_code || "other"),
      reason_text: String(report.reason_text || ""),
      status: isReportStatus(report.status) ? report.status : "open",
      assigned_to_user_id: report.assigned_to_user_id ? toInt(report.assigned_to_user_id) : null,
      created_at: report.created_at || nowIso(),
      resolved_at: report.resolved_at || null
    }))
    .filter((report) => report.id > 0 && report.reporter_user_id > 0 && report.target_id > 0);

  state.moderation_actions = state.moderation_actions
    .map((action) => ({
      id: toInt(action.id),
      actor_user_id: toInt(action.actor_user_id),
      action_type: String(action.action_type || "unknown"),
      target_type: String(action.target_type || "unknown"),
      target_id: toInt(action.target_id),
      notes: String(action.notes || ""),
      created_at: action.created_at || nowIso()
    }))
    .filter((action) => action.id > 0 && action.actor_user_id > 0 && action.target_id > 0);

  state.schema_version = SCHEMA_VERSION;
  state.search_index_meta = {
    last_rebuild_at: state.search_index_meta.last_rebuild_at || null
  };
}

function loadState() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(dbPath, "utf8");
    state = sanitizeState(JSON.parse(raw));
  } catch {
    state = baseState();
  }
  migrateState();
  ensureCategoriesSeeded();
  hydrateCounters(state);
  enqueueWrite();
}

loadState();

function getUserById(id) {
  return state.users.find((user) => user.id === toInt(id)) || null;
}

function getUserByEmail(email) {
  return state.users.find((user) => user.email === normalizeText(email)) || null;
}

function getUserByUsername(username) {
  return state.users.find((user) => user.username.toLowerCase() === normalizeText(username)) || null;
}

function getUsers() {
  return [...state.users].sort((a, b) => a.username.localeCompare(b.username));
}

function createUser({ username, email, password_hash }) {
  const userCount = state.users.length;
  const user = {
    id: nextId("users"),
    username: String(username || "").trim(),
    email: normalizeText(email || ""),
    password_hash: String(password_hash || ""),
    bio: "",
    avatar_url: "",
    created_at: nowIso(),
    role: userCount === 0 ? "admin" : "user",
    status: "active",
    email_verified: false,
    verification_token_hash: null,
    verification_expires_at: null,
    reset_token_hash: null,
    reset_expires_at: null
  };
  state.users.push(user);
  enqueueWrite();
  return user;
}

function setVerificationToken(userId, { tokenHash, expiresAt }) {
  const user = getUserById(userId);
  if (!user) return null;
  user.verification_token_hash = tokenHash;
  user.verification_expires_at = expiresAt;
  enqueueWrite();
  return user;
}

function verifyUserByTokenHash(tokenHash) {
  const now = Date.now();
  const user = state.users.find((item) => {
    if (!item.verification_token_hash) return false;
    if (item.verification_token_hash !== tokenHash) return false;
    if (!item.verification_expires_at) return false;
    return new Date(item.verification_expires_at).getTime() >= now;
  });
  if (!user) return null;
  user.email_verified = true;
  user.verification_token_hash = null;
  user.verification_expires_at = null;
  enqueueWrite();
  return user;
}

function setResetToken(userId, { tokenHash, expiresAt }) {
  const user = getUserById(userId);
  if (!user) return null;
  user.reset_token_hash = tokenHash;
  user.reset_expires_at = expiresAt;
  enqueueWrite();
  return user;
}

function getUserByResetTokenHash(tokenHash) {
  const now = Date.now();
  return (
    state.users.find((item) => {
      if (!item.reset_token_hash) return false;
      if (item.reset_token_hash !== tokenHash) return false;
      if (!item.reset_expires_at) return false;
      return new Date(item.reset_expires_at).getTime() >= now;
    }) || null
  );
}

function resetPasswordByTokenHash(tokenHash, passwordHash) {
  const user = getUserByResetTokenHash(tokenHash);
  if (!user) return null;
  user.password_hash = passwordHash;
  user.reset_token_hash = null;
  user.reset_expires_at = null;
  enqueueWrite();
  return user;
}

function updateUserProfile(id, { bio, avatar_url }) {
  const user = getUserById(id);
  if (!user) return null;
  user.bio = String(bio || "");
  user.avatar_url = String(avatar_url || "");
  enqueueWrite();
  return toPublicUser(user);
}

function updateUserRole(id, role) {
  const user = getUserById(id);
  if (!user || !isRole(role)) return null;
  user.role = role;
  enqueueWrite();
  return user;
}

function updateUserStatus(id, status) {
  const user = getUserById(id);
  if (!user || !isUserStatus(status)) return null;
  user.status = status;
  enqueueWrite();
  return user;
}

function getAllCategories() {
  return [...state.categories].sort((a, b) => {
    if (a.sort_order === b.sort_order) {
      return a.name.localeCompare(b.name);
    }
    return a.sort_order - b.sort_order;
  });
}

function getCategoryById(id) {
  return state.categories.find((category) => category.id === toInt(id)) || null;
}

function getCategoryBySlug(slug) {
  return state.categories.find((category) => category.slug === slug) || null;
}

function getTagBySlug(slug) {
  return state.tags.find((tag) => tag.slug === slug) || null;
}

function getTagById(id) {
  return state.tags.find((tag) => tag.id === toInt(id)) || null;
}

function getTagsForPost(postId) {
  const relations = state.post_tags.filter((item) => item.post_id === toInt(postId));
  const tags = [];
  for (const relation of relations) {
    const tag = getTagById(relation.tag_id);
    if (tag) {
      tags.push({ id: tag.id, name: tag.name, slug: tag.slug });
    }
  }
  return tags.sort((a, b) => a.name.localeCompare(b.name));
}

function getOrCreateTag(nameInput) {
  const name = String(nameInput || "").trim();
  if (!name) return null;
  const slugBase = slugify(name);
  if (!slugBase) return null;

  let existing = state.tags.find((tag) => tag.slug === slugBase);
  if (existing) return existing;

  let slug = slugBase;
  let index = 1;
  while (state.tags.some((tag) => tag.slug === slug)) {
    index += 1;
    slug = `${slugBase}-${index}`;
  }

  existing = {
    id: nextId("tags"),
    slug,
    name,
    created_at: nowIso()
  };
  state.tags.push(existing);
  return existing;
}

function setPostTags(postId, tagNames) {
  const uniqueNames = [];
  const seen = new Set();
  for (const rawName of tagNames || []) {
    const normalized = String(rawName || "").trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueNames.push(normalized);
    if (uniqueNames.length >= 5) break;
  }

  state.post_tags = state.post_tags.filter((item) => item.post_id !== toInt(postId));
  for (const item of uniqueNames) {
    const tag = getOrCreateTag(item);
    if (!tag) continue;
    state.post_tags.push({
      post_id: toInt(postId),
      tag_id: tag.id
    });
  }
}

function countLikes(postId) {
  return state.likes.filter((like) => like.post_id === toInt(postId)).length;
}

function countBookmarks(postId) {
  return state.bookmarks.filter((bookmark) => bookmark.post_id === toInt(postId)).length;
}

function canSeeHiddenPost(post, viewer) {
  if (!post.is_hidden) return true;
  return canViewHidden({ viewer, authorId: post.user_id });
}

function getVisibleCommentsForPost(postId, viewer) {
  const comments = state.comments
    .filter((comment) => comment.post_id === toInt(postId))
    .sort((a, b) => {
      if (a.path === b.path) {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return a.path.localeCompare(b.path);
    });

  const hiddenPrefixes = [];
  const visible = [];
  for (const comment of comments) {
    if (hiddenPrefixes.some((prefix) => comment.path.startsWith(prefix))) {
      continue;
    }
    const allowed = canViewHidden({ viewer, authorId: comment.user_id });
    if (comment.is_hidden && !allowed) {
      hiddenPrefixes.push(`${comment.path}.`);
      continue;
    }
    visible.push(comment);
  }
  return visible;
}

function countVisibleComments(postId, viewer) {
  return getVisibleCommentsForPost(postId, viewer).length;
}

function buildSearchText(post) {
  const author = getUserById(post.user_id);
  const category = getCategoryById(post.category_id);
  const tags = getTagsForPost(post.id);
  const parts = [
    post.title,
    post.markdown_body,
    author ? author.username : "",
    category ? category.name : "",
    ...tags.map((tag) => tag.name)
  ];
  return normalizeText(parts.join(" "));
}

function decoratePost(post, viewerId) {
  const viewer = viewerId ? toPublicUser(getUserById(viewerId)) : null;
  const author = getUserById(post.user_id);
  const category = getCategoryById(post.category_id);
  const tags = getTagsForPost(post.id);
  const likeCount = countLikes(post.id);
  const bookmarkCount = countBookmarks(post.id);
  const commentCount = countVisibleComments(post.id, viewer);
  const likedByMe = viewer ? state.likes.some((like) => like.post_id === post.id && like.user_id === viewer.id) : false;
  const bookmarkedByMe = viewer
    ? state.bookmarks.some((bookmark) => bookmark.post_id === post.id && bookmark.user_id === viewer.id)
    : false;

  return {
    id: post.id,
    title: post.title,
    markdown_body: post.markdown_body,
    rendered_html: post.rendered_html,
    excerpt: post.excerpt,
    reading_time_minutes: post.reading_time_minutes,
    media_url: post.media_url,
    media_type: post.media_type,
    created_at: post.created_at,
    is_hidden: post.is_hidden,
    hidden_reason: post.hidden_reason || "",
    author_id: author ? author.id : null,
    author_username: author ? author.username : "deleted",
    author_avatar_url: author ? author.avatar_url || "" : "",
    author_status: author ? author.status : "active",
    category_name: category ? category.name : "Unknown",
    category_slug: category ? category.slug : "unknown",
    like_count: likeCount,
    comment_count: commentCount,
    bookmark_count: bookmarkCount,
    liked_by_me: likedByMe ? 1 : 0,
    bookmarked_by_me: bookmarkedByMe ? 1 : 0,
    tags
  };
}

function filterPostsForFeed({ viewerId, categorySlug, tagSlug, query }) {
  const viewer = viewerId ? toPublicUser(getUserById(viewerId)) : null;
  const category = categorySlug ? getCategoryBySlug(categorySlug) : null;
  const tag = tagSlug ? getTagBySlug(tagSlug) : null;
  const normQuery = normalizeText(query || "");
  const tagPostIds = new Set(
    tag ? state.post_tags.filter((item) => item.tag_id === tag.id).map((item) => item.post_id) : []
  );

  return state.posts
    .filter((post) => {
      if (!canSeeHiddenPost(post, viewer)) return false;
      if (category && post.category_id !== category.id) return false;
      if (tag && !tagPostIds.has(post.id)) return false;
      if (normQuery && !buildSearchText(post).includes(normQuery)) return false;
      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

function paginate(items, page, pageSize) {
  const size = Math.min(Math.max(pageSize || 10, 1), MAX_PAGE_SIZE);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(page || 1, 1), pages);
  const start = (safePage - 1) * size;
  const records = items.slice(start, start + size);
  return {
    items: records,
    total,
    pages,
    page: safePage,
    pageSize: size
  };
}

function getFeedPosts({ viewerId, categorySlug, tagSlug, query, page = 1, pageSize = 10 }) {
  const filtered = filterPostsForFeed({ viewerId, categorySlug, tagSlug, query });
  const result = paginate(filtered, page, pageSize);
  return {
    ...result,
    items: result.items.map((post) => decoratePost(post, viewerId))
  };
}

function getSearchPosts({ viewerId, query, page = 1, pageSize = 10 }) {
  return getFeedPosts({ viewerId, query, page, pageSize });
}

function createPost({
  user_id,
  category_id,
  title,
  markdown_body,
  rendered_html,
  excerpt,
  reading_time_minutes,
  media_url,
  media_type,
  tag_names
}) {
  const post = {
    id: nextId("posts"),
    user_id: toInt(user_id),
    category_id: toInt(category_id),
    title: String(title || "").trim(),
    markdown_body: String(markdown_body || ""),
    rendered_html: String(rendered_html || ""),
    excerpt: String(excerpt || summarize(markdown_body)),
    reading_time_minutes: Number(reading_time_minutes || computeReadingTime(markdown_body)),
    media_url: String(media_url || ""),
    media_type: ["none", "image", "video"].includes(media_type) ? media_type : "none",
    is_hidden: false,
    hidden_reason: "",
    created_at: nowIso()
  };
  state.posts.push(post);
  setPostTags(post.id, tag_names || []);
  state.search_index_meta.last_rebuild_at = nowIso();
  enqueueWrite();
  return post;
}

function getPostRawById(postId) {
  return state.posts.find((post) => post.id === toInt(postId)) || null;
}

function getPostById({ postId, viewerId }) {
  const post = getPostRawById(postId);
  if (!post) return null;
  const viewer = viewerId ? toPublicUser(getUserById(viewerId)) : null;
  if (!canSeeHiddenPost(post, viewer)) return null;
  return decoratePost(post, viewerId);
}

function getPostByIdForModeration(postId) {
  return getPostRawById(postId);
}

function hidePost(postId, reason = "") {
  const post = getPostRawById(postId);
  if (!post) return null;
  post.is_hidden = true;
  post.hidden_reason = String(reason || "");
  enqueueWrite();
  return post;
}

function unhidePost(postId) {
  const post = getPostRawById(postId);
  if (!post) return null;
  post.is_hidden = false;
  post.hidden_reason = "";
  enqueueWrite();
  return post;
}

function hasLike({ userId, postId }) {
  return state.likes.some((like) => like.user_id === toInt(userId) && like.post_id === toInt(postId));
}

function toggleLike({ userId, postId }) {
  const existing = state.likes.find(
    (like) => like.user_id === toInt(userId) && like.post_id === toInt(postId)
  );
  if (existing) {
    state.likes = state.likes.filter((like) => like.id !== existing.id);
    enqueueWrite();
    return false;
  }
  state.likes.push({
    id: nextId("likes"),
    user_id: toInt(userId),
    post_id: toInt(postId),
    created_at: nowIso()
  });
  enqueueWrite();
  return true;
}

function hasBookmark({ userId, postId }) {
  return state.bookmarks.some(
    (bookmark) => bookmark.user_id === toInt(userId) && bookmark.post_id === toInt(postId)
  );
}

function toggleBookmark({ userId, postId }) {
  const existing = state.bookmarks.find(
    (bookmark) => bookmark.user_id === toInt(userId) && bookmark.post_id === toInt(postId)
  );
  if (existing) {
    state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== existing.id);
    enqueueWrite();
    return false;
  }
  state.bookmarks.push({
    id: nextId("bookmarks"),
    user_id: toInt(userId),
    post_id: toInt(postId),
    created_at: nowIso()
  });
  enqueueWrite();
  return true;
}

function getUserPosts(userId, viewerId) {
  const viewer = viewerId ? toPublicUser(getUserById(viewerId)) : null;
  const posts = state.posts
    .filter((post) => post.user_id === toInt(userId))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .filter((post) => canSeeHiddenPost(post, viewer));
  return posts.map((post) => decoratePost(post, viewerId));
}

function getUserBookmarks(userId, { page = 1, pageSize = 10 } = {}) {
  const viewer = toPublicUser(getUserById(userId));
  const postIds = state.bookmarks
    .filter((bookmark) => bookmark.user_id === toInt(userId))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((bookmark) => bookmark.post_id);
  const posts = postIds
    .map((postId) => getPostRawById(postId))
    .filter(Boolean)
    .filter((post) => canSeeHiddenPost(post, viewer));
  const paged = paginate(posts, page, pageSize);
  return {
    ...paged,
    items: paged.items.map((post) => decoratePost(post, userId))
  };
}

function getTrendingPosts(limit = 5) {
  return [...state.posts]
    .filter((post) => !post.is_hidden)
    .map((post) => {
      const author = getUserById(post.user_id);
      return {
        id: post.id,
        title: post.title,
        author_username: author ? author.username : "deleted",
        like_count: countLikes(post.id),
        created_at: post.created_at
      };
    })
    .sort((a, b) => {
      if (b.like_count === a.like_count) {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      return b.like_count - a.like_count;
    })
    .slice(0, limit)
    .map(({ created_at, ...rest }) => rest);
}

function getTopCreators(limit = 5) {
  return state.users
    .map((user) => {
      const posts = state.posts.filter((post) => post.user_id === user.id && !post.is_hidden);
      const likes = posts.reduce((sum, post) => sum + countLikes(post.id), 0);
      return {
        username: user.username,
        avatar_url: user.avatar_url || "",
        post_count: posts.length,
        received_likes: likes,
        role: user.role,
        created_at: user.created_at
      };
    })
    .sort((a, b) => {
      if (b.received_likes === a.received_likes) {
        if (b.post_count === a.post_count) {
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
        return b.post_count - a.post_count;
      }
      return b.received_likes - a.received_likes;
    })
    .slice(0, limit)
    .map(({ created_at, ...rest }) => rest);
}

function getPopularTags(limit = 20) {
  const usage = new Map();
  for (const relation of state.post_tags) {
    usage.set(relation.tag_id, (usage.get(relation.tag_id) || 0) + 1);
  }
  return [...state.tags]
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      slug: tag.slug,
      usage_count: usage.get(tag.id) || 0
    }))
    .sort((a, b) => {
      if (b.usage_count === a.usage_count) {
        return a.name.localeCompare(b.name);
      }
      return b.usage_count - a.usage_count;
    })
    .slice(0, limit);
}

function getCommentRawById(commentId) {
  return state.comments.find((comment) => comment.id === toInt(commentId)) || null;
}

function buildCommentPath(parent, newCommentId) {
  if (!parent) return padId(newCommentId);
  return `${parent.path}.${padId(newCommentId)}`;
}

function addComment({ user_id, post_id, body, parent_comment_id = null }) {
  const parent = parent_comment_id ? getCommentRawById(parent_comment_id) : null;
  if (parent && parent.post_id !== toInt(post_id)) {
    return null;
  }
  const id = nextId("comments");
  const depth = parent ? Number(parent.depth || 0) + 1 : 0;
  const pathValue = buildCommentPath(parent, id);
  const comment = {
    id,
    user_id: toInt(user_id),
    post_id: toInt(post_id),
    parent_comment_id: parent ? parent.id : null,
    depth,
    path: pathValue,
    body: String(body || ""),
    is_hidden: false,
    hidden_reason: "",
    created_at: nowIso()
  };
  state.comments.push(comment);
  enqueueWrite();
  return comment;
}

function hideComment(commentId, reason = "") {
  const comment = getCommentRawById(commentId);
  if (!comment) return null;
  comment.is_hidden = true;
  comment.hidden_reason = String(reason || "");
  enqueueWrite();
  return comment;
}

function unhideComment(commentId) {
  const comment = getCommentRawById(commentId);
  if (!comment) return null;
  comment.is_hidden = false;
  comment.hidden_reason = "";
  enqueueWrite();
  return comment;
}

function getCommentReactions(commentId) {
  const counts = {
    like: 0,
    heart: 0,
    fire: 0,
    clap: 0
  };
  for (const reaction of state.comment_reactions) {
    if (reaction.comment_id !== toInt(commentId)) continue;
    if (isReaction(reaction.reaction_type)) {
      counts[reaction.reaction_type] += 1;
    }
  }
  return counts;
}

function getViewerCommentReactions(commentId, viewerId) {
  if (!viewerId) return [];
  return state.comment_reactions
    .filter((reaction) => reaction.comment_id === toInt(commentId) && reaction.user_id === toInt(viewerId))
    .map((reaction) => reaction.reaction_type);
}

function toggleCommentReaction({ userId, commentId, reactionType }) {
  if (!isReaction(reactionType)) return null;
  const existing = state.comment_reactions.find(
    (item) =>
      item.comment_id === toInt(commentId) &&
      item.user_id === toInt(userId) &&
      item.reaction_type === reactionType
  );
  if (existing) {
    state.comment_reactions = state.comment_reactions.filter((item) => item.id !== existing.id);
    enqueueWrite();
    return false;
  }
  state.comment_reactions.push({
    id: nextId("comment_reactions"),
    comment_id: toInt(commentId),
    user_id: toInt(userId),
    reaction_type: reactionType,
    created_at: nowIso()
  });
  enqueueWrite();
  return true;
}

function getPostComments(postId, viewerId) {
  const viewer = viewerId ? toPublicUser(getUserById(viewerId)) : null;
  const comments = getVisibleCommentsForPost(postId, viewer);
  return comments.map((comment) => {
    const author = getUserById(comment.user_id);
    return {
      id: comment.id,
      body: comment.body,
      created_at: comment.created_at,
      post_id: comment.post_id,
      parent_comment_id: comment.parent_comment_id,
      depth: comment.depth,
      path: comment.path,
      is_hidden: comment.is_hidden,
      hidden_reason: comment.hidden_reason,
      author_id: author ? author.id : null,
      author_username: author ? author.username : "deleted",
      author_avatar_url: author ? author.avatar_url || "" : "",
      reactions: getCommentReactions(comment.id),
      viewer_reactions: getViewerCommentReactions(comment.id, viewerId)
    };
  });
}

function createReport({ reporter_user_id, target_type, target_id, reason_code, reason_text }) {
  const report = {
    id: nextId("reports"),
    reporter_user_id: toInt(reporter_user_id),
    target_type,
    target_id: toInt(target_id),
    reason_code: String(reason_code || "other"),
    reason_text: String(reason_text || ""),
    status: "open",
    assigned_to_user_id: null,
    created_at: nowIso(),
    resolved_at: null
  };
  state.reports.push(report);
  enqueueWrite();
  return report;
}

function addModerationAction({ actor_user_id, action_type, target_type, target_id, notes }) {
  const action = {
    id: nextId("moderation_actions"),
    actor_user_id: toInt(actor_user_id),
    action_type: String(action_type || "unknown"),
    target_type: String(target_type || "unknown"),
    target_id: toInt(target_id),
    notes: String(notes || ""),
    created_at: nowIso()
  };
  state.moderation_actions.push(action);
  enqueueWrite();
  return action;
}

function getReports({ status = "open", page = 1, pageSize = 20 } = {}) {
  const filtered = state.reports
    .filter((report) => {
      if (status === "all") return true;
      return report.status === status;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const paged = paginate(filtered, page, pageSize);
  return {
    ...paged,
    items: paged.items.map((report) => {
      const reporter = getUserById(report.reporter_user_id);
      const assignee = report.assigned_to_user_id ? getUserById(report.assigned_to_user_id) : null;
      return {
        ...report,
        reporter_username: reporter ? reporter.username : "deleted",
        assignee_username: assignee ? assignee.username : ""
      };
    })
  };
}

function getReportById(id) {
  return state.reports.find((report) => report.id === toInt(id)) || null;
}

function assignReport(reportId, moderatorId) {
  const report = getReportById(reportId);
  if (!report) return null;
  report.assigned_to_user_id = toInt(moderatorId);
  if (report.status === "open") {
    report.status = "in_review";
  }
  enqueueWrite();
  return report;
}

function resolveReport(reportId, status) {
  const report = getReportById(reportId);
  if (!report) return null;
  if (!["resolved", "dismissed"].includes(status)) return null;
  report.status = status;
  report.resolved_at = nowIso();
  enqueueWrite();
  return report;
}

function getModerationActionsForTarget(targetType, targetId, limit = 30) {
  return state.moderation_actions
    .filter((item) => item.target_type === targetType && item.target_id === toInt(targetId))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)
    .map((action) => {
      const actor = getUserById(action.actor_user_id);
      return {
        ...action,
        actor_username: actor ? actor.username : "deleted"
      };
    });
}

function getAdminUserList() {
  return getUsers().map((user) => {
    const postCount = state.posts.filter((post) => post.user_id === user.id).length;
    const reportCount = state.reports.filter((report) => report.reporter_user_id === user.id).length;
    return {
      ...toPublicUser(user),
      post_count: postCount,
      report_count: reportCount
    };
  });
}

function getBookmarkCountForUser(userId) {
  return state.bookmarks.filter((bookmark) => bookmark.user_id === toInt(userId)).length;
}

module.exports = {
  SCHEMA_VERSION,
  REACTIONS,
  ROLES,
  USER_STATUS,
  REPORT_STATUS,
  toPublicUser,
  isModeratorRole,
  isAdminRole,
  canUserModerate,
  canUserAdmin,
  summarize,
  computeReadingTime,
  getUserById,
  getUserByEmail,
  getUserByUsername,
  getUsers,
  createUser,
  setVerificationToken,
  verifyUserByTokenHash,
  setResetToken,
  getUserByResetTokenHash,
  resetPasswordByTokenHash,
  updateUserProfile,
  updateUserRole,
  updateUserStatus,
  getAllCategories,
  getCategoryById,
  getCategoryBySlug,
  getTagBySlug,
  getPopularTags,
  getFeedPosts,
  getSearchPosts,
  createPost,
  getPostById,
  getPostByIdForModeration,
  hidePost,
  unhidePost,
  hasLike,
  toggleLike,
  hasBookmark,
  toggleBookmark,
  getUserPosts,
  getUserBookmarks,
  getTrendingPosts,
  getTopCreators,
  getPostComments,
  addComment,
  getCommentRawById,
  hideComment,
  unhideComment,
  toggleCommentReaction,
  createReport,
  addModerationAction,
  getReports,
  getReportById,
  assignReport,
  resolveReport,
  getModerationActionsForTarget,
  getAdminUserList,
  getBookmarkCountForUser
};
