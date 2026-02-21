const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { marked } = require("marked");
const sanitizeHtml = require("sanitize-html");
const db = require("./db");
const { sendMail } = require("./mailer");

const FileStore = require("session-file-store")(session);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const PAGE_SIZE = 10;

const BLOCKED_WORDS = String(process.env.BLOCKED_WORDS || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function parsePage(value) {
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) return 1;
  return page;
}

function relativeTime(input) {
  const value = new Date(input).getTime();
  const now = Date.now();
  const diffSec = Math.max(1, Math.floor((now - value) / 1000));
  const units = [
    { label: "y", seconds: 31536000 },
    { label: "mo", seconds: 2592000 },
    { label: "d", seconds: 86400 },
    { label: "h", seconds: 3600 },
    { label: "m", seconds: 60 }
  ];
  for (const unit of units) {
    if (diffSec >= unit.seconds) {
      return `${Math.floor(diffSec / unit.seconds)}${unit.label} ago`;
    }
  }
  return "just now";
}

function toYouTubeEmbedUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.replace("/", "");
      return id ? `https://www.youtube.com/embed/${id}` : "";
    }
    if (parsed.hostname.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : "";
    }
    return "";
  } catch {
    return "";
  }
}

function mapPostForView(post) {
  const embedUrl = post.media_type === "video" ? toYouTubeEmbedUrl(post.media_url) : "";
  return {
    ...post,
    created_relative: relativeTime(post.created_at),
    youtube_embed_url: embedUrl
  };
}

function normalizeMedia(mediaType, mediaUrl) {
  if (!mediaUrl) {
    return { mediaType: "none", mediaUrl: "" };
  }
  return { mediaType, mediaUrl: mediaUrl.trim() };
}

function parseTags(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 5);
}

function parseBlockedWord(text) {
  const lower = String(text || "").toLowerCase();
  for (const word of BLOCKED_WORDS) {
    if (word && lower.includes(word)) {
      return word;
    }
  }
  return null;
}

function sanitizeRenderedMarkdown(markdown) {
  const rawHtml = marked.parse(markdown || "");
  return sanitizeHtml(rawHtml, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "p",
      "br",
      "strong",
      "em",
      "blockquote",
      "ul",
      "ol",
      "li",
      "a",
      "code",
      "pre",
      "img"
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt"],
      code: ["class"]
    },
    allowedSchemes: ["http", "https", "mailto"]
  });
}

function buildQuery(params) {
  const url = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.set(key, String(value));
  }
  return url.toString();
}

function redirectBack(req, res, fallback = "/") {
  return res.redirect(req.get("referer") || fallback);
}

function createTokenPayload(hours = 24) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  return { token, tokenHash: hash, expiresAt };
}

async function sendVerificationEmail(user, token) {
  const url = `${APP_BASE_URL}/verify-email/${token}`;
  await sendMail({
    to: user.email,
    subject: "Verify your Viks Media account",
    text: `Verify your account: ${url}`,
    html: `<p>Verify your account by opening this link:</p><p><a href="${url}">${url}</a></p>`
  });
}

async function sendResetEmail(user, token) {
  const url = `${APP_BASE_URL}/reset-password/${token}`;
  await sendMail({
    to: user.email,
    subject: "Reset your Viks Media password",
    text: `Reset your password: ${url}`,
    html: `<p>Reset your password using this link:</p><p><a href="${url}">${url}</a></p>`
  });
}

function buildCommentRows(comments) {
  return comments.map((comment) => ({
    ...comment,
    created_relative: relativeTime(comment.created_at),
    indent_level: Math.min(comment.depth, 12),
    deep_collapsed: comment.depth > 12
  }));
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    setFlash(req, "error", "Please log in to continue.");
    return res.redirect("/login");
  }
  return next();
}

function requireVerified(req, res, next) {
  if (!req.currentUser) {
    setFlash(req, "error", "Please log in to continue.");
    return res.redirect("/login");
  }
  if (!req.currentUser.email_verified) {
    setFlash(req, "error", "Please verify your email first.");
    return res.redirect("/account");
  }
  if (req.currentUser.status !== "active") {
    setFlash(req, "error", "Your account is restricted.");
    return res.redirect("/");
  }
  return next();
}

function requireModerator(req, res, next) {
  if (!req.currentUser || !db.canUserModerate(req.currentUser)) {
    return res.status(403).render("not-found", { pageTitle: "Not found" });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.currentUser || !db.canUserAdmin(req.currentUser)) {
    return res.status(403).render("not-found", { pageTitle: "Not found" });
  }
  return next();
}

const authLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_AUTH) || 25,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    setFlash(req, "error", "Too many requests. Please wait and try again.");
    return redirectBack(req, res, "/");
  }
});

const writeLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_POSTS) || 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    setFlash(req, "error", "Action limited. Please slow down.");
    return redirectBack(req, res, "/");
  }
});

const toggleLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: 160,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    setFlash(req, "error", "Too many actions. Please wait and retry.");
    return redirectBack(req, res, "/");
  }
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
  session({
    store: new FileStore({
      path: path.join(__dirname, "..", "data", "sessions"),
      retries: 0
    }),
    secret: process.env.SESSION_SECRET || "replace-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 14,
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

app.use((req, res, next) => {
  const userId = Number(req.session.userId);
  const currentUserRaw = userId ? db.getUserById(userId) : null;
  const currentUser = db.toPublicUser(currentUserRaw);

  if (currentUser && currentUser.status !== "active") {
    req.session.destroy(() => {});
    res.locals.currentUser = null;
    req.currentUser = null;
  } else {
    res.locals.currentUser = currentUser || null;
    req.currentUser = currentUser || null;
  }

  res.locals.categories = db.getAllCategories();
  res.locals.popularTags = db.getPopularTags(24);
  res.locals.creators = db.getTopCreators(5);
  res.locals.trending = db.getTrendingPosts(6);
  res.locals.notifications = req.currentUser ? db.getUserNotifications(req.currentUser.id, 20) : [];
  res.locals.query = typeof req.query.q === "string" ? req.query.q : "";
  res.locals.activePath = req.path;
  res.locals.flash = req.session.flash || null;
  res.locals.canModerate = Boolean(req.currentUser && db.canUserModerate(req.currentUser));
  res.locals.canAdmin = Boolean(req.currentUser && db.canUserAdmin(req.currentUser));
  req.session.flash = null;
  next();
});

app.get("/", (req, res) => {
  const categorySlug = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const tagSlug = typeof req.query.tag === "string" ? req.query.tag.trim() : "";
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const page = parsePage(req.query.page);

  const feed = db.getFeedPosts({
    viewerId: req.currentUser ? req.currentUser.id : null,
    categorySlug: categorySlug || null,
    tagSlug: tagSlug || null,
    query: q || null,
    page,
    pageSize: PAGE_SIZE
  });

  const selectedCategory = categorySlug ? db.getCategoryBySlug(categorySlug) : null;
  const selectedTag = tagSlug ? db.getTagBySlug(tagSlug) : null;
  const posts = feed.items.map(mapPostForView);

  res.render("index", {
    pageTitle: q
      ? `Search: ${q}`
      : selectedTag
        ? `Tag: ${selectedTag.name}`
        : selectedCategory
          ? `${selectedCategory.name} publications`
          : "Latest publications",
    posts,
    selectedCategory,
    selectedTag,
    query: q,
    pagination: {
      page: feed.page,
      pages: feed.pages,
      total: feed.total
    },
    filters: {
      category: categorySlug,
      tag: tagSlug,
      q
    },
    trending: db.getTrendingPosts(),
    creators: db.getTopCreators()
  });
});

app.get("/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const page = parsePage(req.query.page);
  const search = db.getSearchPosts({
    viewerId: req.currentUser ? req.currentUser.id : null,
    query: q || null,
    page,
    pageSize: PAGE_SIZE
  });
  const posts = search.items.map(mapPostForView);
  res.render("index", {
    pageTitle: q ? `Search: ${q}` : "Search",
    posts,
    selectedCategory: null,
    selectedTag: null,
    query: q,
    pagination: {
      page: search.page,
      pages: search.pages,
      total: search.total
    },
    filters: {
      category: "",
      tag: "",
      q
    },
    trending: db.getTrendingPosts(),
    creators: db.getTopCreators()
  });
});

app.get("/categories/:slug", (req, res) => {
  return res.redirect(`/?${buildQuery({ category: req.params.slug })}`);
});

app.get("/tags/:slug", (req, res) => {
  return res.redirect(`/?${buildQuery({ tag: req.params.slug })}`);
});

app.get("/register", (req, res) => {
  if (req.currentUser) return res.redirect("/");
  return res.render("register", { pageTitle: "Create account" });
});

app.post("/register", authLimiter, async (req, res) => {
  if (req.currentUser) return res.redirect("/");

  const username = (req.body.username || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  if (username.length < 3 || username.length > 24) {
    setFlash(req, "error", "Username must be 3 to 24 characters.");
    return res.redirect("/register");
  }
  if (!email.includes("@") || email.length < 5) {
    setFlash(req, "error", "Enter a valid email address.");
    return res.redirect("/register");
  }
  if (password.length < 6) {
    setFlash(req, "error", "Password must be at least 6 characters.");
    return res.redirect("/register");
  }
  if (db.getUserByEmail(email)) {
    setFlash(req, "error", "Email is already in use.");
    return res.redirect("/register");
  }
  if (db.getUserByUsername(username)) {
    setFlash(req, "error", "Username is already in use.");
    return res.redirect("/register");
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const user = db.createUser({ username, email, password_hash: passwordHash });
  const tokenData = createTokenPayload(24);
  db.setVerificationToken(user.id, tokenData);
  try {
    await sendVerificationEmail(user, tokenData.token);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Verification email failed", error);
  }
  req.session.userId = user.id;
  setFlash(req, "success", "Account created. Verify your email to unlock publishing actions.");
  return res.redirect("/account");
});

app.get("/verify-email/:token", (req, res) => {
  const token = String(req.params.token || "");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const user = db.verifyUserByTokenHash(tokenHash);
  if (!user) {
    setFlash(req, "error", "Verification link is invalid or expired.");
    return res.redirect("/login");
  }
  req.session.userId = user.id;
  setFlash(req, "success", "Email verified. You can now post and interact.");
  return res.redirect("/account");
});

app.post("/resend-verification", requireAuth, authLimiter, async (req, res) => {
  const user = db.getUserById(req.currentUser.id);
  if (!user) return res.redirect("/login");
  if (user.email_verified) {
    setFlash(req, "success", "Your email is already verified.");
    return res.redirect("/account");
  }
  const tokenData = createTokenPayload(24);
  db.setVerificationToken(user.id, tokenData);
  try {
    await sendVerificationEmail(user, tokenData.token);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Resend verification failed", error);
  }
  setFlash(req, "success", "Verification email sent.");
  return res.redirect("/account");
});

app.get("/login", (req, res) => {
  if (req.currentUser) return res.redirect("/");
  return res.render("login", { pageTitle: "Log in" });
});

app.post("/login", authLimiter, (req, res) => {
  if (req.currentUser) return res.redirect("/");

  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const user = db.getUserByEmail(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    setFlash(req, "error", "Invalid email or password.");
    return res.redirect("/login");
  }
  if (user.status !== "active") {
    setFlash(req, "error", "This account is restricted.");
    return res.redirect("/login");
  }
  req.session.userId = user.id;
  setFlash(req, "success", "Welcome back.");
  return res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/forgot-password", (req, res) => {
  return res.render("forgot-password", { pageTitle: "Forgot password" });
});

app.post("/forgot-password", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const user = db.getUserByEmail(email);
  if (user && user.status === "active") {
    const tokenData = createTokenPayload(1);
    db.setResetToken(user.id, tokenData);
    try {
      await sendResetEmail(user, tokenData.token);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Reset email failed", error);
    }
  }
  setFlash(req, "success", "If this email exists, a reset link has been sent.");
  return res.redirect("/login");
});

app.get("/reset-password/:token", (req, res) => {
  const token = String(req.params.token || "");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const user = db.getUserByResetTokenHash(tokenHash);
  return res.render("reset-password", {
    pageTitle: "Reset password",
    token,
    isValidToken: Boolean(user)
  });
});

app.post("/reset-password/:token", authLimiter, (req, res) => {
  const token = String(req.params.token || "");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const user = db.getUserByResetTokenHash(tokenHash);
  const password = req.body.password || "";
  const confirmPassword = req.body.confirm_password || "";

  if (!user) {
    setFlash(req, "error", "Reset token is invalid or expired.");
    return res.redirect("/forgot-password");
  }
  if (password.length < 6) {
    setFlash(req, "error", "Password must be at least 6 characters.");
    return res.redirect(`/reset-password/${encodeURIComponent(token)}`);
  }
  if (password !== confirmPassword) {
    setFlash(req, "error", "Passwords do not match.");
    return res.redirect(`/reset-password/${encodeURIComponent(token)}`);
  }
  const passwordHash = bcrypt.hashSync(password, 12);
  db.resetPasswordByTokenHash(tokenHash, passwordHash);
  setFlash(req, "success", "Password updated. You can now log in.");
  return res.redirect("/login");
});

app.get("/posts/new", requireAuth, requireVerified, (req, res) => {
  return res.render("new-post", { pageTitle: "New publication" });
});

app.post("/preview-markdown", requireAuth, requireVerified, writeLimiter, (req, res) => {
  const markdown = String(req.body.markdown || "");
  return res.json({
    html: sanitizeRenderedMarkdown(markdown)
  });
});

app.post("/posts", requireAuth, requireVerified, writeLimiter, (req, res) => {
  const categoryId = Number(req.body.category_id);
  const title = (req.body.title || "").trim();
  const markdownBody = (req.body.markdown_body || "").trim();
  const mediaType = (req.body.media_type || "none").trim();
  const mediaUrl = (req.body.media_url || "").trim();
  const tagNames = parseTags(req.body.tags || "");

  const category = db.getCategoryById(categoryId);
  if (!category) {
    setFlash(req, "error", "Choose a valid category.");
    return res.redirect("/posts/new");
  }
  if (title.length < 6 || title.length > 160) {
    setFlash(req, "error", "Title must be 6 to 160 characters.");
    return res.redirect("/posts/new");
  }
  if (markdownBody.length < 20) {
    setFlash(req, "error", "Publication text must be at least 20 characters.");
    return res.redirect("/posts/new");
  }
  if (!["none", "image", "video"].includes(mediaType)) {
    setFlash(req, "error", "Unsupported media type.");
    return res.redirect("/posts/new");
  }
  if (mediaType !== "none" && mediaUrl.length < 5) {
    setFlash(req, "error", "Media URL is required for image or video posts.");
    return res.redirect("/posts/new");
  }

  const blocked = parseBlockedWord(`${title} ${markdownBody}`);
  if (blocked) {
    setFlash(req, "error", `Blocked content detected: "${blocked}".`);
    return res.redirect("/posts/new");
  }

  const normalized = normalizeMedia(mediaType, mediaUrl);
  const renderedHtml = sanitizeRenderedMarkdown(markdownBody);
  const post = db.createPost({
    user_id: req.currentUser.id,
    category_id: categoryId,
    title,
    markdown_body: markdownBody,
    rendered_html: renderedHtml,
    excerpt: db.summarize(markdownBody),
    reading_time_minutes: db.computeReadingTime(markdownBody),
    media_url: normalized.mediaUrl,
    media_type: normalized.mediaType,
    tag_names: tagNames
  });
  setFlash(req, "success", "Publication posted.");
  return res.redirect(`/posts/${post.id}`);
});

app.get("/posts/:id", (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isInteger(postId) || postId <= 0) {
    return res.status(404).render("not-found", { pageTitle: "Not found" });
  }

  const post = db.getPostById({
    postId,
    viewerId: req.currentUser ? req.currentUser.id : null
  });
  if (!post) {
    return res.status(404).render("not-found", { pageTitle: "Not found" });
  }

  const comments = buildCommentRows(db.getPostComments(postId, req.currentUser ? req.currentUser.id : null));
  const auditTrail = db.canUserModerate(req.currentUser)
    ? db.getModerationActionsForTarget("post", postId, 15)
    : [];

  return res.render("post", {
    pageTitle: post.title,
    post: mapPostForView(post),
    comments,
    reactions: db.REACTIONS,
    auditTrail
  });
});

app.post("/posts/:id/like", requireAuth, requireVerified, toggleLimiter, (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isInteger(postId) || postId <= 0) return res.redirect("/");
  const post = db.getPostByIdForModeration(postId);
  if (!post) {
    setFlash(req, "error", "Post was not found.");
    return res.redirect("/");
  }
  db.toggleLike({ userId: req.currentUser.id, postId });
  return res.redirect(req.get("referer") || `/posts/${postId}`);
});

app.post("/posts/:id/bookmark", requireAuth, requireVerified, toggleLimiter, (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isInteger(postId) || postId <= 0) return res.redirect("/");
  const post = db.getPostByIdForModeration(postId);
  if (!post) {
    setFlash(req, "error", "Post was not found.");
    return res.redirect("/");
  }
  db.toggleBookmark({ userId: req.currentUser.id, postId });
  return res.redirect(req.get("referer") || `/posts/${postId}`);
});

app.post("/posts/:id/comments", requireAuth, requireVerified, writeLimiter, (req, res) => {
  const postId = Number(req.params.id);
  const body = (req.body.body || "").trim();
  if (!Number.isInteger(postId) || postId <= 0) return res.redirect("/");
  if (body.length < 2 || body.length > 1500) {
    setFlash(req, "error", "Comment must be 2 to 1500 characters.");
    return res.redirect(`/posts/${postId}`);
  }
  const blocked = parseBlockedWord(body);
  if (blocked) {
    setFlash(req, "error", `Blocked content detected: "${blocked}".`);
    return res.redirect(`/posts/${postId}`);
  }
  const post = db.getPostByIdForModeration(postId);
  if (!post) {
    setFlash(req, "error", "Post was not found.");
    return res.redirect("/");
  }
  db.addComment({ user_id: req.currentUser.id, post_id: postId, body, parent_comment_id: null });
  setFlash(req, "success", "Comment added.");
  return res.redirect(`/posts/${postId}#comments`);
});

app.post("/posts/:id/comments/:commentId/reply", requireAuth, requireVerified, writeLimiter, (req, res) => {
  const postId = Number(req.params.id);
  const commentId = Number(req.params.commentId);
  const body = (req.body.body || "").trim();

  if (!Number.isInteger(postId) || postId <= 0) return res.redirect("/");
  if (!Number.isInteger(commentId) || commentId <= 0) return res.redirect(`/posts/${postId}`);
  if (body.length < 2 || body.length > 1500) {
    setFlash(req, "error", "Reply must be 2 to 1500 characters.");
    return res.redirect(`/posts/${postId}`);
  }
  const blocked = parseBlockedWord(body);
  if (blocked) {
    setFlash(req, "error", `Blocked content detected: "${blocked}".`);
    return res.redirect(`/posts/${postId}`);
  }
  const parent = db.getCommentRawById(commentId);
  if (!parent || parent.post_id !== postId) {
    setFlash(req, "error", "Parent comment was not found.");
    return res.redirect(`/posts/${postId}`);
  }
  db.addComment({
    user_id: req.currentUser.id,
    post_id: postId,
    body,
    parent_comment_id: commentId
  });
  setFlash(req, "success", "Reply added.");
  return res.redirect(`/posts/${postId}#comments`);
});

app.post(
  "/posts/:id/comments/:commentId/reactions",
  requireAuth,
  requireVerified,
  toggleLimiter,
  (req, res) => {
    const postId = Number(req.params.id);
    const commentId = Number(req.params.commentId);
    const reactionType = String(req.body.reaction_type || "").trim();

    if (!Number.isInteger(postId) || postId <= 0) return res.redirect("/");
    if (!Number.isInteger(commentId) || commentId <= 0) return res.redirect(`/posts/${postId}`);
    const comment = db.getCommentRawById(commentId);
    if (!comment || comment.post_id !== postId) {
      setFlash(req, "error", "Comment not found.");
      return res.redirect(`/posts/${postId}`);
    }
    if (!db.REACTIONS.includes(reactionType)) {
      setFlash(req, "error", "Unsupported reaction.");
      return res.redirect(`/posts/${postId}`);
    }

    db.toggleCommentReaction({
      userId: req.currentUser.id,
      commentId,
      reactionType
    });
    return res.redirect(`/posts/${postId}#comment-${commentId}`);
  }
);

app.post("/reports", requireAuth, requireVerified, writeLimiter, (req, res) => {
  const targetType = String(req.body.target_type || "").trim();
  const targetId = Number(req.body.target_id);
  const reasonCode = String(req.body.reason_code || "other").trim();
  const reasonText = (req.body.reason_text || "").trim();

  if (!["post", "comment", "user"].includes(targetType) || !Number.isInteger(targetId) || targetId <= 0) {
    setFlash(req, "error", "Invalid report target.");
    return redirectBack(req, res, "/");
  }
  if (reasonText.length > 500) {
    setFlash(req, "error", "Report note is too long.");
    return redirectBack(req, res, "/");
  }
  const blocked = parseBlockedWord(reasonText);
  if (blocked) {
    setFlash(req, "error", `Blocked content detected: "${blocked}".`);
    return redirectBack(req, res, "/");
  }

  let targetExists = false;
  if (targetType === "post") {
    targetExists = Boolean(db.getPostByIdForModeration(targetId));
  } else if (targetType === "comment") {
    targetExists = Boolean(db.getCommentRawById(targetId));
  } else if (targetType === "user") {
    targetExists = Boolean(db.getUserById(targetId));
  }
  if (!targetExists) {
    setFlash(req, "error", "The content you are reporting was not found.");
    return redirectBack(req, res, "/");
  }

  db.createReport({
    reporter_user_id: req.currentUser.id,
    target_type: targetType,
    target_id: targetId,
    reason_code: reasonCode,
    reason_text: reasonText
  });
  setFlash(req, "success", "Report submitted.");
  return redirectBack(req, res, "/");
});

app.get("/bookmarks", requireAuth, requireVerified, (req, res) => {
  const page = parsePage(req.query.page);
  const bookmarks = db.getUserBookmarks(req.currentUser.id, { page, pageSize: PAGE_SIZE });
  return res.render("bookmarks", {
    pageTitle: "Bookmarks",
    posts: bookmarks.items.map(mapPostForView),
    pagination: {
      page: bookmarks.page,
      pages: bookmarks.pages,
      total: bookmarks.total
    }
  });
});

app.get("/account", requireAuth, (req, res) => {
  const tab = String(req.query.tab || "posts");
  const posts = db.getUserPosts(req.currentUser.id, req.currentUser.id).map(mapPostForView);
  const bookmarkPage = parsePage(req.query.bookmark_page);
  const bookmarks = db.getUserBookmarks(req.currentUser.id, { page: bookmarkPage, pageSize: PAGE_SIZE });
  const moderationStatus = String(req.query.status || "open");
  const moderationPage = parsePage(req.query.mod_page);
  const moderation = db.canUserModerate(req.currentUser)
    ? db.getReports({ status: moderationStatus, page: moderationPage, pageSize: 20 })
    : null;

  return res.render("account", {
    pageTitle: "My account",
    profileUser: req.currentUser,
    isOwner: true,
    tab,
    posts,
    bookmarks,
    moderationStatus,
    moderation
  });
});

app.post("/account", requireAuth, (req, res) => {
  const bio = (req.body.bio || "").trim();
  const avatarUrl = (req.body.avatar_url || "").trim();

  if (bio.length > 280) {
    setFlash(req, "error", "Bio must be at most 280 characters.");
    return res.redirect("/account");
  }
  if (avatarUrl.length > 500) {
    setFlash(req, "error", "Avatar URL is too long.");
    return res.redirect("/account");
  }

  db.updateUserProfile(req.currentUser.id, { bio, avatar_url: avatarUrl });
  setFlash(req, "success", "Account updated.");
  return res.redirect("/account");
});

app.get("/u/:username", (req, res) => {
  const username = req.params.username;
  const profileUserRaw = db.getUserByUsername(username);
  const profileUser = db.toPublicUser(profileUserRaw);
  if (!profileUser) {
    return res.status(404).render("not-found", { pageTitle: "Not found" });
  }

  const viewerId = req.currentUser ? req.currentUser.id : null;
  const posts = db.getUserPosts(profileUser.id, viewerId).map(mapPostForView);
  const isOwner = req.currentUser && req.currentUser.id === profileUser.id;

  return res.render("account-public", {
    pageTitle: `${profileUser.username} profile`,
    profileUser,
    posts,
    isOwner
  });
});

app.get("/moderation/queue", requireAuth, requireModerator, (req, res) => {
  const status = String(req.query.status || "open");
  const page = parsePage(req.query.page);
  const reports = db.getReports({ status, page, pageSize: 25 });
  return res.render("moderation-queue", {
    pageTitle: "Moderation queue",
    status,
    reports
  });
});

app.post("/moderation/reports/:id/assign", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const reportId = Number(req.params.id);
  const report = db.assignReport(reportId, req.currentUser.id);
  if (!report) {
    setFlash(req, "error", "Report not found.");
    return res.redirect("/moderation/queue");
  }
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "report.assign",
    target_type: "report",
    target_id: report.id,
    notes: "Assigned to moderator"
  });
  setFlash(req, "success", "Report assigned.");
  return res.redirect(req.get("referer") || "/moderation/queue");
});

app.post("/moderation/reports/:id/resolve", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const reportId = Number(req.params.id);
  const status = String(req.body.status || "").trim();
  const notes = (req.body.notes || "").trim();
  const report = db.resolveReport(reportId, status);
  if (!report) {
    setFlash(req, "error", "Report not found or invalid status.");
    return res.redirect("/moderation/queue");
  }
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: `report.${status}`,
    target_type: "report",
    target_id: report.id,
    notes
  });
  setFlash(req, "success", "Report updated.");
  return res.redirect(req.get("referer") || "/moderation/queue");
});

app.post("/moderation/posts/:id/hide", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const postId = Number(req.params.id);
  const reason = (req.body.reason || "").trim();
  const post = db.hidePost(postId, reason);
  if (!post) {
    setFlash(req, "error", "Post not found.");
    return res.redirect("/moderation/queue");
  }
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "post.hide",
    target_type: "post",
    target_id: postId,
    notes: reason
  });
  setFlash(req, "success", "Post hidden.");
  return res.redirect(req.get("referer") || `/posts/${postId}`);
});

app.post("/moderation/posts/:id/unhide", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.unhidePost(postId);
  if (!post) {
    setFlash(req, "error", "Post not found.");
    return res.redirect("/moderation/queue");
  }
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "post.unhide",
    target_type: "post",
    target_id: postId,
    notes: ""
  });
  setFlash(req, "success", "Post restored.");
  return res.redirect(req.get("referer") || `/posts/${postId}`);
});

app.post("/moderation/comments/:id/hide", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const commentId = Number(req.params.id);
  const reason = (req.body.reason || "").trim();
  const comment = db.hideComment(commentId, reason);
  if (!comment) {
    setFlash(req, "error", "Comment not found.");
    return res.redirect("/moderation/queue");
  }
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "comment.hide",
    target_type: "comment",
    target_id: commentId,
    notes: reason
  });
  setFlash(req, "success", "Comment hidden.");
  return res.redirect(req.get("referer") || `/posts/${comment.post_id}`);
});

app.post("/moderation/comments/:id/unhide", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const commentId = Number(req.params.id);
  const comment = db.unhideComment(commentId);
  if (!comment) {
    setFlash(req, "error", "Comment not found.");
    return res.redirect("/moderation/queue");
  }
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "comment.unhide",
    target_type: "comment",
    target_id: commentId,
    notes: ""
  });
  setFlash(req, "success", "Comment restored.");
  return res.redirect(req.get("referer") || `/posts/${comment.post_id}`);
});

app.post("/moderation/users/:id/suspend", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const userId = Number(req.params.id);
  const target = db.getUserById(userId);
  if (!target) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/moderation/queue");
  }
  if (target.role === "admin" && !db.canUserAdmin(req.currentUser)) {
    setFlash(req, "error", "Only admins can change admin status.");
    return res.redirect("/moderation/queue");
  }
  db.updateUserStatus(userId, "suspended");
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "user.suspend",
    target_type: "user",
    target_id: userId,
    notes: ""
  });
  setFlash(req, "success", "User suspended.");
  return res.redirect(req.get("referer") || "/moderation/queue");
});

app.post("/moderation/users/:id/ban", requireAuth, requireModerator, writeLimiter, (req, res) => {
  const userId = Number(req.params.id);
  const target = db.getUserById(userId);
  if (!target) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/moderation/queue");
  }
  if (target.role === "admin" && !db.canUserAdmin(req.currentUser)) {
    setFlash(req, "error", "Only admins can change admin status.");
    return res.redirect("/moderation/queue");
  }
  db.updateUserStatus(userId, "banned");
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "user.ban",
    target_type: "user",
    target_id: userId,
    notes: ""
  });
  setFlash(req, "success", "User banned.");
  return res.redirect(req.get("referer") || "/moderation/queue");
});

app.get("/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.getAdminUserList();
  return res.render("admin-users", {
    pageTitle: "User management",
    users
  });
});

app.get("/notifications", requireAuth, (req, res) => {
  return res.render("notifications", {
    pageTitle: "Notifications",
    items: db.getUserNotifications(req.currentUser.id, 120)
  });
});

app.post("/admin/users/:id/role", requireAuth, requireAdmin, writeLimiter, (req, res) => {
  const userId = Number(req.params.id);
  const role = String(req.body.role || "").trim();
  if (!db.ROLES.includes(role)) {
    setFlash(req, "error", "Invalid role.");
    return res.redirect("/admin/users");
  }
  const target = db.getUserById(userId);
  if (!target) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/admin/users");
  }
  if (target.id === req.currentUser.id && role !== "admin") {
    setFlash(req, "error", "You cannot remove your own admin role.");
    return res.redirect("/admin/users");
  }
  db.updateUserRole(userId, role);
  db.addModerationAction({
    actor_user_id: req.currentUser.id,
    action_type: "user.role.update",
    target_type: "user",
    target_id: userId,
    notes: `Role set to ${role}`
  });
  setFlash(req, "success", "Role updated.");
  return res.redirect("/admin/users");
});

app.use((req, res) => {
  res.status(404).render("not-found", { pageTitle: "Not found" });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`viks-media is running on http://localhost:${PORT}`);
});
