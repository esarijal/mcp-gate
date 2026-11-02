import { UserError, ok, type Env, type JsonSchema, type Tool } from "../../core/types.ts";
import { listAccounts, resolveApiKey } from "./accounts.ts";
import { bufferGraphQL, toUtcIso, unwrapMutation } from "./client.ts";

// ---------------------------------------------------------------------------
// Skema argumen bersama
// ---------------------------------------------------------------------------

const ID = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } as const satisfies JsonSchema;

const account: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9_ -]{1,40}$",
  description: "Label akun Buffer (lihat buffer_list_accounts). Boleh dikosongkan bila hanya ada satu akun.",
};

const organizationId: JsonSchema = {
  ...ID,
  description: "ID organisasi Buffer. Boleh dikosongkan bila akun hanya punya satu organisasi.",
};

const THREAD_SERVICES = new Set(["twitter", "bluesky", "threads", "mastodon"]);
const MAX_TEXT = 10_000;

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const Q_ACCOUNT = /* GraphQL */ `
  query Account {
    account { id name timezone organizations { id name } }
  }`;

const Q_CHANNELS = /* GraphQL */ `
  query Channels($input: ChannelsInput!) {
    channels(input: $input) {
      id name displayName service type timezone isDisconnected isLocked isQueuePaused
    }
  }`;

const Q_CHANNEL_SERVICE = /* GraphQL */ `
  query ChannelService($input: ChannelInput!) {
    channel(input: $input) { id service }
  }`;

const Q_POSTS = /* GraphQL */ `
  query Posts($input: PostsInput!, $first: Int, $after: String) {
    posts(input: $input, first: $first, after: $after) {
      edges { node { id text status channelId channelService dueAt sentAt createdAt shareMode externalLink } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const POST_FIELDS = "id text status channelId channelService dueAt shareMode externalLink";

const M_CREATE = /* GraphQL */ `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      __typename
      ... on PostActionSuccess { post { ${POST_FIELDS} } }
      ... on MutationError { message }
    }
  }`;

const M_EDIT = /* GraphQL */ `
  mutation EditPost($input: EditPostInput!) {
    editPost(input: $input) {
      __typename
      ... on PostActionSuccess { post { ${POST_FIELDS} } }
      ... on MutationError { message }
    }
  }`;

const M_DELETE = /* GraphQL */ `
  mutation DeletePost($input: DeletePostInput!) {
    deletePost(input: $input) {
      __typename
      ... on DeletePostSuccess { id }
      ... on MutationError { message }
    }
  }`;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface Org {
  id: string;
  name: string;
}

async function getOrganizations(apiKey: string): Promise<Org[]> {
  const data = await bufferGraphQL<{ account: { organizations: Org[] } }>(apiKey, Q_ACCOUNT);
  return data.account?.organizations ?? [];
}

async function pickOrganization(apiKey: string, requested: unknown): Promise<string> {
  if (typeof requested === "string" && requested) return requested;
  const orgs = await getOrganizations(apiKey);
  if (orgs.length === 1) return orgs[0]!.id;
  if (orgs.length === 0) throw new UserError("Akun ini tidak punya organisasi Buffer.");
  throw new UserError(
    `Akun ini punya beberapa organisasi. Isi organizationId dengan salah satu: ${orgs
      .map((o) => `${o.name} (${o.id})`)
      .join(", ")}.`,
  );
}

function buildAssets(images: unknown, video: unknown): Record<string, unknown>[] | undefined {
  const imageList = Array.isArray(images) ? (images as string[]) : [];
  if (imageList.length && video) throw new UserError("Pilih gambar atau video, tidak keduanya.");
  if (video) return [{ video: { url: video } }];
  if (imageList.length) return imageList.map((url) => ({ image: { url } }));
  return undefined;
}

function futureUtc(value: unknown): string {
  const iso = toUtcIso(value);
  if (new Date(iso).getTime() <= Date.now() + 60_000) {
    throw new UserError("dueAt harus minimal 1 menit di masa depan.");
  }
  return iso;
}

const withAccount = (label: string, data: unknown) => ({ account: label, ...((data as object) ?? {}) });

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const bufferTools: Tool[] = [
  {
    name: "buffer_list_accounts",
    scope: "mcp:read",
    description: "Daftar label akun Buffer yang tersambung ke gerbang ini. Panggil ini dulu sebelum tool Buffer lain.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Daftar akun Buffer", readOnlyHint: true, openWorldHint: false },
    handler: async (_args, env: Env) => ok({ accounts: [...listAccounts(env).keys()] }),
  },
  {
    name: "buffer_get_account",
    scope: "mcp:read",
    description: "Detail satu akun Buffer: nama, zona waktu, dan daftar organisasi.",
    inputSchema: { type: "object", properties: { account }, additionalProperties: false },
    annotations: { title: "Detail akun Buffer", readOnlyHint: true, openWorldHint: true },
    handler: async (args, env) => {
      const { label, apiKey } = resolveApiKey(env, args.account);
      const data = await bufferGraphQL<{ account: unknown }>(apiKey, Q_ACCOUNT);
      return ok(withAccount(label, data.account));
    },
  },
  {
    name: "buffer_list_channels",
    scope: "mcp:read",
    description: "Daftar channel media sosial (Instagram, Threads, dll.) di sebuah akun Buffer, beserta ID-nya.",
    inputSchema: { type: "object", properties: { account, organizationId }, additionalProperties: false },
    annotations: { title: "Daftar channel", readOnlyHint: true, openWorldHint: true },
    handler: async (args, env) => {
      const { label, apiKey } = resolveApiKey(env, args.account);
      const orgId = await pickOrganization(apiKey, args.organizationId);
      const data = await bufferGraphQL<{ channels: unknown[] }>(apiKey, Q_CHANNELS, {
        input: { organizationId: orgId },
      });
      return ok({ account: label, organizationId: orgId, channels: data.channels });
    },
  },
  {
    name: "buffer_list_posts",
    scope: "mcp:read",
    description: "Daftar postingan di akun Buffer, bisa difilter per channel dan status (mis. scheduled, sent, draft, error).",
    inputSchema: {
      type: "object",
      properties: {
        account,
        organizationId,
        channelIds: { type: "array", items: ID, maxItems: 20, description: "Filter channel (opsional)." },
        status: {
          type: "array",
          maxItems: 5,
          items: { type: "string", pattern: "^[a-z_]{1,32}$" },
          description: "Filter status, huruf kecil, mis. [\"scheduled\"] (opsional).",
        },
        first: { type: "integer", minimum: 1, maximum: 50, description: "Jumlah per halaman (default 20)." },
        after: { type: "string", maxLength: 500, description: "Kursor halaman berikutnya (endCursor)." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Daftar postingan", readOnlyHint: true, openWorldHint: true },
    handler: async (args, env) => {
      const { label, apiKey } = resolveApiKey(env, args.account);
      const orgId = await pickOrganization(apiKey, args.organizationId);
      const filter: Record<string, unknown> = {};
      if (Array.isArray(args.channelIds) && args.channelIds.length) filter.channelIds = args.channelIds;
      if (Array.isArray(args.status) && args.status.length) filter.status = args.status;
      const data = await bufferGraphQL<{ posts: unknown }>(apiKey, Q_POSTS, {
        input: {
          organizationId: orgId,
          ...(Object.keys(filter).length ? { filter } : {}),
          sort: [{ field: "dueAt", direction: "desc" }],
        },
        first: typeof args.first === "number" ? args.first : 20,
        ...(typeof args.after === "string" ? { after: args.after } : {}),
      });
      return ok({ account: label, organizationId: orgId, posts: data.posts });
    },
  },
  {
    name: "buffer_create_post",
    scope: "mcp:write",
    description:
      "Buat postingan di satu channel Buffer. Default: masuk antrean (addToQueue). " +
      "WAJIB tunjukkan akun, channel, dan isi lengkap ke pengguna dan dapatkan persetujuan sebelum memanggil.",
    inputSchema: {
      type: "object",
      required: ["channelId", "text"],
      additionalProperties: false,
      properties: {
        account,
        channelId: { ...ID, description: "ID channel dari buffer_list_channels." },
        text: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: "Isi postingan." },
        mode: {
          type: "string",
          enum: ["addToQueue", "shareNow", "shareNext", "customScheduled"],
          description:
            "addToQueue (default), shareNext, customScheduled (pakai dueAt), atau shareNow. " +
            "PERINGATAN: shareNow langsung tayang publik dan tidak bisa ditarik lewat Buffer; pakai hanya bila pengguna memintanya secara eksplisit.",
        },
        dueAt: {
          type: "string",
          maxLength: 40,
          format: "date-time",
          description: "Waktu tayang ISO 8601 dengan zona waktu, mis. 2026-11-05T19:30:00+07:00. Mengaktifkan customScheduled.",
        },
        saveToDraft: { type: "boolean", description: "Simpan sebagai draf, tidak dijadwalkan." },
        imageUrls: {
          type: "array",
          maxItems: 10,
          items: { type: "string", maxLength: 2048, format: "https-url" },
          description: "URL gambar publik (https).",
        },
        videoUrl: { type: "string", maxLength: 2048, format: "https-url", description: "URL video publik (https)." },
        instagramType: { type: "string", enum: ["post", "reel", "story"], description: "Khusus channel Instagram." },
        shouldShareToFeed: { type: "boolean", description: "Khusus Instagram reel: tampilkan juga di feed." },
        thread: {
          type: "array",
          maxItems: 24,
          items: { type: "string", minLength: 1, maxLength: MAX_TEXT },
          description: "Lanjutan utas setelah `text` (Threads, X, Bluesky, Mastodon). Tiap item jadi balasan berikutnya.",
        },
      },
    },
    annotations: { title: "Buat postingan", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, env) => {
      const { label, apiKey } = resolveApiKey(env, args.account);
      const text = String(args.text);

      let mode = (args.mode as string | undefined) ?? (args.dueAt ? "customScheduled" : "addToQueue");
      let dueAt: string | undefined;
      if (args.dueAt) {
        if (mode !== "customScheduled") throw new UserError("dueAt hanya bisa dipakai dengan mode customScheduled.");
        dueAt = futureUtc(args.dueAt);
      } else if (mode === "customScheduled") {
        throw new UserError("Mode customScheduled butuh dueAt.");
      }

      const metadata: Record<string, unknown> = {};
      if (args.instagramType || args.shouldShareToFeed !== undefined) {
        metadata.instagram = {
          type: args.instagramType ?? "post",
          ...(args.shouldShareToFeed !== undefined ? { shouldShareToFeed: args.shouldShareToFeed } : {}),
        };
      }
      if (Array.isArray(args.thread) && args.thread.length) {
        const ch = await bufferGraphQL<{ channel: { service: string } }>(apiKey, Q_CHANNEL_SERVICE, {
          input: { id: args.channelId },
        });
        const service = String(ch.channel?.service ?? "").toLowerCase();
        if (!THREAD_SERVICES.has(service)) throw new UserError(`Channel ${service || "ini"} tidak mendukung utas.`);
        metadata[service] = { thread: [text, ...(args.thread as string[])].map((t) => ({ text: t })) };
      }

      const assets = buildAssets(args.imageUrls, args.videoUrl);
      const input: Record<string, unknown> = {
        channelId: args.channelId,
        text,
        schedulingType: "automatic",
        mode,
        assets: assets ?? [],
        ...(dueAt ? { dueAt } : {}),
        ...(args.saveToDraft ? { saveToDraft: true } : {}),
        ...(Object.keys(metadata).length ? { metadata } : {}),
        source: "mcp-gate",
      };
      const data = await bufferGraphQL<{ createPost: Record<string, unknown> }>(apiKey, M_CREATE, { input });
      const result = unwrapMutation(data.createPost, "membuat postingan");
      return ok({ account: label, post: result.post });
    },
  },
  {
    name: "buffer_edit_post",
    scope: "mcp:write",
    description:
      "Ubah postingan yang belum tayang (teks, jadwal, mode, atau gambar). Tunjukkan perubahan ke pengguna dan minta persetujuan dulu.",
    inputSchema: {
      type: "object",
      required: ["postId"],
      additionalProperties: false,
      properties: {
        account,
        postId: { ...ID, description: "ID postingan dari buffer_list_posts." },
        text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
        mode: { type: "string", enum: ["addToQueue", "shareNow", "shareNext", "customScheduled"] },
        dueAt: { type: "string", maxLength: 40, format: "date-time" },
        imageUrls: { type: "array", maxItems: 10, items: { type: "string", maxLength: 2048, format: "https-url" } },
      },
    },
    annotations: { title: "Ubah postingan", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, env) => {
      const { label, apiKey } = resolveApiKey(env, args.account);
      const input: Record<string, unknown> = { id: args.postId };
      if (args.text !== undefined) input.text = args.text;
      if (args.dueAt !== undefined) {
        input.dueAt = futureUtc(args.dueAt);
        input.mode = "customScheduled";
      }
      if (args.mode !== undefined) {
        if (args.dueAt !== undefined && args.mode !== "customScheduled")
          throw new UserError("dueAt hanya bisa dipakai dengan mode customScheduled.");
        input.mode = args.mode;
      }
      if (Array.isArray(args.imageUrls)) input.assets = buildAssets(args.imageUrls, undefined) ?? [];
      if (Object.keys(input).length === 1) throw new UserError("Tidak ada perubahan yang diminta.");
      const data = await bufferGraphQL<{ editPost: Record<string, unknown> }>(apiKey, M_EDIT, { input });
      const result = unwrapMutation(data.editPost, "mengubah postingan");
      return ok({ account: label, post: result.post });
    },
  },
  {
    name: "buffer_delete_post",
    scope: "mcp:write",
    description: "Hapus postingan dari Buffer. Tidak bisa dibatalkan. Minta konfirmasi eksplisit pengguna dulu.",
    inputSchema: {
      type: "object",
      required: ["postId"],
      additionalProperties: false,
      properties: { account, postId: { ...ID, description: "ID postingan." } },
    },
    annotations: { title: "Hapus postingan", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, env) => {
      const { label, apiKey } = resolveApiKey(env, args.account);
      const data = await bufferGraphQL<{ deletePost: Record<string, unknown> }>(apiKey, M_DELETE, {
        input: { id: args.postId },
      });
      const result = unwrapMutation(data.deletePost, "menghapus postingan");
      return ok({ account: label, deletedId: result.id });
    },
  },
];
