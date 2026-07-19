import { PDFDocument } from "pdf-lib";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!corsHeaders) return json({ error: "来源未授权" }, 403);
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "emergency-rescue-export" }, 200, corsHeaders || undefined);
    }

    if (request.method === "POST" && url.pathname === "/api/exports/rescue-record") {
      if (!corsHeaders) return json({ error: "来源未授权" }, 403);
      try {
        return await createExport(request, env, corsHeaders);
      } catch (error) {
        console.error("导出服务创建失败", error && error.name ? error.name : "Error");
        return json({ error: "导出文件生成失败，请稍后重试" }, 500, corsHeaders);
      }
    }

    const fileMatch = url.pathname.match(/^\/api\/exports\/([a-f0-9-]{36})\/file\/(pdf|page)(?:\/(\d+))?$/i);
    if ((request.method === "GET" || request.method === "HEAD") && fileMatch) {
      const [, exportId, kind, pageText] = fileMatch;
      return serveExportFile(request, env, ctx, exportId, kind, Number(pageText || 0), corsHeaders || {});
    }

    return json({ error: "接口不存在" }, 404, corsHeaders || undefined);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(removeExpiredExports(env));
  }
};

async function createExport(request, env, corsHeaders) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({ error: "仅支持图片表单上传" }, 415, corsHeaders);
  }

  const formData = await request.formData();
  const submittedPages = formData.getAll("pages").filter(isUploadFile);
  const maxPages = readNumberEnv(env.MAX_EXPORT_PAGES, 24, 1, 48);
  const maxBytes = readNumberEnv(env.MAX_EXPORT_BYTES, 30000000, 1024 * 1024, 80 * 1024 * 1024);

  if (!submittedPages.length || submittedPages.length > maxPages) {
    return json({ error: `图片页数需为 1 至 ${maxPages} 页` }, 400, corsHeaders);
  }

  let uploadBytes = 0;
  for (const page of submittedPages) {
    if (page.type && page.type !== "image/png") {
      return json({ error: "仅支持 PNG 图片导出" }, 415, corsHeaders);
    }
    uploadBytes += Number(page.size || 0);
  }
  if (uploadBytes > maxBytes) {
    return json({ error: "导出图片过大，请减少页数后重试" }, 413, corsHeaders);
  }

  const baseFilename = safeFilename(formData.get("filename"));
  const pageBuffers = await Promise.all(submittedPages.map(page => page.arrayBuffer()));
  const pdfBytes = await buildPdf(pageBuffers);
  const exportId = crypto.randomUUID();
  const ttlMinutes = readNumberEnv(env.EXPORT_TTL_MINUTES, 30, 5, 120);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60 * 1000);
  const manifest = {
    version: 1,
    exportId,
    filename: baseFilename,
    pageCount: pageBuffers.length,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  const writtenKeys = [];

  try {
    for (let index = 0; index < pageBuffers.length; index += 1) {
      const key = pageKey(exportId, index + 1);
      await env.EXPORT_FILES.put(key, pageBuffers[index], {
        httpMetadata: {
          contentType: "image/png",
          contentDisposition: contentDisposition(`${baseFilename}_第${index + 1}页.png`, "inline"),
          cacheControl: "private, no-store"
        },
        customMetadata: { expiresAt: manifest.expiresAt }
      });
      writtenKeys.push(key);
    }

    const pdfKey = pdfObjectKey(exportId);
    await env.EXPORT_FILES.put(pdfKey, pdfBytes, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: contentDisposition(`${baseFilename}.pdf`, "inline"),
        cacheControl: "private, no-store"
      },
      customMetadata: { expiresAt: manifest.expiresAt }
    });
    writtenKeys.push(pdfKey);

    const manifestKey = manifestObjectKey(exportId);
    await env.EXPORT_FILES.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata: {
        contentType: "application/json;charset=UTF-8",
        cacheControl: "private, no-store"
      },
      customMetadata: { expiresAt: manifest.expiresAt }
    });
    writtenKeys.push(manifestKey);
  } catch (error) {
    await env.EXPORT_FILES.delete(writtenKeys);
    throw error;
  }

  return json({
    exportId,
    expiresAt: manifest.expiresAt,
    pdfSize: pdfBytes.length,
    pdfUrl: makeFileUrl(request, exportId, "pdf"),
    downloadPdfUrl: makeFileUrl(request, exportId, "pdf", 0, true),
    pages: pageBuffers.map((_, index) => ({
      pageNo: index + 1,
      previewUrl: makeFileUrl(request, exportId, "page", index + 1),
      downloadUrl: makeFileUrl(request, exportId, "page", index + 1, true)
    }))
  }, 201, corsHeaders);
}

async function serveExportFile(request, env, ctx, exportId, kind, pageNo, corsHeaders) {
  const manifest = await readManifest(env.EXPORT_FILES, exportId);
  if (!manifest) return json({ error: "导出文件不存在或已被删除" }, 404, corsHeaders);

  if (Date.parse(manifest.expiresAt) <= Date.now()) {
    ctx.waitUntil(deleteExport(env.EXPORT_FILES, manifest));
    return json({ error: "导出文件已过期，请重新生成" }, 410, corsHeaders);
  }

  let key = "";
  let filename = "";
  let contentType = "";
  if (kind === "pdf") {
    key = pdfObjectKey(exportId);
    filename = `${manifest.filename}.pdf`;
    contentType = "application/pdf";
  } else {
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > manifest.pageCount) {
      return json({ error: "图片页码无效" }, 404, corsHeaders);
    }
    key = pageKey(exportId, pageNo);
    filename = `${manifest.filename}_第${pageNo}页.png`;
    contentType = "image/png";
  }

  const object = await env.EXPORT_FILES.get(key);
  if (!object) return json({ error: "导出文件不存在或已被删除" }, 404, corsHeaders);

  const mode = new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline";
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition(filename, mode),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders
    }
  });
}

async function buildPdf(pageBuffers) {
  const document = await PDFDocument.create();
  document.setTitle("急诊抢救记录单");
  document.setCreator("急诊抢救记录单微信导出服务");

  for (const buffer of pageBuffers) {
    const image = await document.embedPng(buffer);
    const page = document.addPage([A4_WIDTH, A4_HEIGHT]);
    const scale = Math.min(A4_WIDTH / image.width, A4_HEIGHT / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: (A4_WIDTH - width) / 2,
      y: (A4_HEIGHT - height) / 2,
      width,
      height
    });
  }

  return document.save();
}

async function readManifest(bucket, exportId) {
  const object = await bucket.get(manifestObjectKey(exportId));
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch (_) {
    return null;
  }
}

async function removeExpiredExports(env) {
  let cursor;
  do {
    const listing = await env.EXPORT_FILES.list({ prefix: "manifests/", cursor, limit: 1000 });
    cursor = listing.truncated ? listing.cursor : undefined;
    const manifests = await Promise.all(listing.objects.map(async object => {
      try {
        const entry = await env.EXPORT_FILES.get(object.key);
        return entry ? JSON.parse(await entry.text()) : null;
      } catch (_) {
        return null;
      }
    }));
    await Promise.all(manifests
      .filter(manifest => manifest && Date.parse(manifest.expiresAt) <= Date.now())
      .map(manifest => deleteExport(env.EXPORT_FILES, manifest)));
  } while (cursor);
}

async function deleteExport(bucket, manifest) {
  const keys = [manifestObjectKey(manifest.exportId), pdfObjectKey(manifest.exportId)];
  for (let pageNo = 1; pageNo <= Number(manifest.pageCount || 0); pageNo += 1) {
    keys.push(pageKey(manifest.exportId, pageNo));
  }
  await bucket.delete(keys);
}

function makeFileUrl(request, exportId, kind, pageNo = 0, download = false) {
  const url = new URL(request.url);
  url.pathname = kind === "pdf"
    ? `/api/exports/${exportId}/file/pdf`
    : `/api/exports/${exportId}/file/page/${pageNo}`;
  url.search = download ? "?download=1" : "";
  return url.toString();
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  if (!allowedOrigins.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(payload, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Cache-Control": "no-store",
      ...corsHeaders
    }
  });
}

function isUploadFile(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.size === "number";
}

function readNumberEnv(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function safeFilename(value) {
  const normalized = String(value || "急诊抢救记录单")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.(pdf|png)$/i, "")
    .slice(0, 80);
  return normalized || "急诊抢救记录单";
}

function contentDisposition(filename, mode) {
  const extension = String(filename).toLowerCase().endsWith(".pdf") ? ".pdf" : ".png";
  const fallback = mode === "attachment" ? "emergency-rescue-record" : "emergency-rescue-record-preview";
  return `${mode}; filename="${fallback}${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function manifestObjectKey(exportId) {
  return `manifests/${exportId}.json`;
}

function pdfObjectKey(exportId) {
  return `exports/${exportId}/急诊抢救记录单.pdf`;
}

function pageKey(exportId, pageNo) {
  return `exports/${exportId}/第${pageNo}页.png`;
}
