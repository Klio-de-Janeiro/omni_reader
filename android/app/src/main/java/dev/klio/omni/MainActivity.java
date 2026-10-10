package dev.klio.omni;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PrintDocumentAdapter;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.print.PageRange;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.webkit.JsPromptResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.UUID;
import android.content.res.Configuration;

/** Offline-only Android host with system file selection and scoped exports. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/index.html";
    private static final long MAX_BYTES = 500_000_000L - 1;
    private static final int PICK_FILE = 10;
    private static final int SAVE_FILE = 11;
    private WebView web;
    private ValueCallback<Uri[]> chooser;
    private Uri pendingUri;
    private String pendingToken;
    private File exportFile;
    private OutputStream exportStream;
    private long exportBytes;
    private String exportName;
    private boolean saving;
    private WebView pdfView;
    private File pdfHtml;
    private String pdfToken, pdfError;
    private boolean pdfOpened;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(2, 6, 17));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " OmniAndroid/0.3.0");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return localResponse(request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !START.equals(request.getUrl().toString());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (START.equals(url)) notifyImport();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivityForResult(intent, PICK_FILE); }
                catch (Exception error) { chooser.onReceiveValue(null); chooser = null; toast("Не найден системный выбор файлов."); }
                return true;
            }
            @Override public boolean onJsPrompt(WebView view, String url, String message, String value, JsPromptResult result) {
                if (!"OMNI_NATIVE".equals(message)) { result.cancel(); return true; }
                if (!START.equals(url) || !START.equals(view.getUrl())) { result.cancel(); return true; }
                try { result.confirm(handleCommand(new JSONObject(value))); }
                catch (Exception error) { result.confirm("error:" + error.getMessage()); }
                return true;
            }
        });
        setContentView(web);
        receiveIntent(getIntent());
        web.loadUrl(START);
    }

    private WebResourceResponse localResponse(WebResourceRequest request) {
        Uri uri = request.getUrl();
        try {
            if (!"GET".equals(request.getMethod()) || !"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost())) return errorResponse();
            String path = uri.getPath();
            if (path == null || path.contains("..") || path.indexOf('\0') >= 0) return errorResponse();
            if (pdfHtml != null && path.equals("/native-print/" + pdfToken)) {
                HashMap<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;");
                return new WebResourceResponse("text/html", "UTF-8", 200, "OK", headers, new FileInputStream(pdfHtml));
            }
            if (pendingUri != null && path.equals("/native/" + pendingToken)) {
                InputStream stream = getContentResolver().openInputStream(pendingUri);
                if (stream == null) return errorResponse();
                return new WebResourceResponse("application/octet-stream", null, bounded(stream));
            }
            if ("/".equals(path)) path = "/index.html";
            return new WebResourceResponse(mime(path), "UTF-8", getAssets().open("www" + path));
        } catch (Exception error) { return errorResponse(); }
    }

    private static InputStream bounded(InputStream source) {
        return new FilterInputStream(source) {
            private long remaining = MAX_BYTES;
            @Override public int read(byte[] data, int offset, int length) throws IOException {
                if (remaining <= 0) { if (super.read() != -1) throw new IOException("File exceeds limit"); return -1; }
                int count = super.read(data, offset, (int) Math.min(length, remaining));
                if (count > 0) remaining -= count;
                return count;
            }
            @Override public int read() throws IOException {
                int value = super.read();
                if (value != -1 && --remaining < 0) throw new IOException("File exceeds limit");
                return value;
            }
        };
    }

    private static WebResourceResponse errorResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".woff2")) return "font/woff2";
        if (path.endsWith(".ttf")) return "font/ttf";
        if (path.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    private String handleCommand(JSONObject command) throws Exception {
        switch (command.getString("action")) {
            case "system-theme":
                return new JSONObject().put("dark", (getResources().getConfiguration().uiMode
                        & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES).toString();
            case "fullscreen": {
                boolean enabled = command.getBoolean("enabled");
                int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
                if (enabled) flags |= View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
                web.setSystemUiVisibility(flags);
                return "ok";
            }
            case "copy": {
                String text = command.getString("text");
                if (text.length() > 2_000_000) throw new IOException("Слишком большое выделение.");
                ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Omni", text));
                return "ok";
            }
            case "pending": return pendingMetadata();
            case "import-done": pendingUri = null; pendingToken = null; return "ok";
            case "export-start": {
                if (saving || pdfToken != null) throw new IOException("Дождитесь завершения сохранения.");
                closeExport();
                exportName = new File(command.getString("name").replace('\\', '/')).getName();
                if (exportName.isEmpty() || exportName.length() > 240) throw new IOException("Недопустимое имя.");
                exportFile = File.createTempFile("omni-export-", ".tmp", getCacheDir());
                exportStream = new FileOutputStream(exportFile); exportBytes = 0; return "ok";
            }
            case "export-chunk": {
                if (exportStream == null) throw new IOException("Нет активного экспорта.");
                String data = command.getString("data");
                if (data.length() > 70000) throw new IOException("Слишком большой блок.");
                byte[] chunk = Base64.decode(data, Base64.DEFAULT);
                exportBytes += chunk.length;
                if (exportBytes > MAX_BYTES) { closeExport(); throw new IOException("Размер файла должен быть меньше 500 МБ."); }
                exportStream.write(chunk); return "ok";
            }
            case "export-finish": {
                if (exportStream == null) throw new IOException("Нет файла для сохранения.");
                exportStream.close(); exportStream = null;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("application/octet-stream");
                intent.putExtra(Intent.EXTRA_TITLE, exportName); saving = true;
                try { startActivityForResult(intent, SAVE_FILE); } catch (RuntimeException error) { saving = false; closeExport(); throw error; } return "ok";
            }
            case "pdf-render": startPdf(command.getString("name")); return "ok";
            case "pdf-status": {
                JSONObject status = new JSONObject().put("opened", pdfOpened);
                if (pdfError != null) status.put("error", pdfError);
                return status.toString();
            }
            case "pdf-close": closePdf(); return "ok";
            case "export-cancel": if (!saving) closeExport(); return "ok";
            default: throw new IOException("Неизвестная команда.");
        }
    }

    /** Use Android's supported print flow; the user selects Save as PDF. */
    private void startPdf(String name) throws Exception {
        if (pdfToken != null || exportStream == null || exportFile == null) throw new IOException("Нет документа для PDF.");
        exportStream.close(); exportStream = null;
        pdfHtml = exportFile; exportFile = null; pdfToken = UUID.randomUUID().toString(); pdfError = null; pdfOpened = false;
        final String token = pdfToken;
        pdfView = new WebView(this);
        pdfView.getSettings().setJavaScriptEnabled(false);
        pdfView.getSettings().setAllowFileAccess(false);
        pdfView.getSettings().setAllowContentAccess(false);
        pdfView.setWebViewClient(new WebViewClient() {
            private boolean started;
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return localResponse(request); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public void onPageFinished(WebView view, String url) {
                if (started || !token.equals(pdfToken) || !url.equals(ORIGIN + "/native-print/" + token)) return;
                started = true;
                try {
                    final PrintDocumentAdapter delegate = view.createPrintDocumentAdapter(name);
                    PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                        @Override public void onStart() { delegate.onStart(); }
                        @Override public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal signal, LayoutResultCallback callback, Bundle extras) { delegate.onLayout(oldAttributes, newAttributes, signal, callback, extras); }
                        @Override public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal signal, WriteResultCallback callback) { delegate.onWrite(pages, destination, signal, callback); }
                        @Override public void onFinish() { delegate.onFinish(); if (token.equals(pdfToken)) closePdf(); }
                    };
                    PrintManager manager = (PrintManager) getSystemService(PRINT_SERVICE);
                    if (manager == null) throw new IOException("Служба печати недоступна.");
                    PrintAttributes attributes = new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).setMinMargins(PrintAttributes.Margins.NO_MARGINS).setColorMode(PrintAttributes.COLOR_MODE_COLOR).build();
                    manager.print(name, adapter, attributes); pdfOpened = true;
                } catch (Exception error) { pdfError = "Не удалось открыть печать PDF: " + error.getMessage(); }
            }
        });
        pdfView.loadUrl(ORIGIN + "/native-print/" + token);
    }
    private void closePdf() {
        pdfToken = null;
        if (pdfView != null) pdfView.destroy(); pdfView = null;
        if (pdfHtml != null) pdfHtml.delete(); pdfHtml = null;
    }

    private String pendingMetadata() throws Exception {
        if (pendingUri == null) return "null";
        String name = "file"; long size = -1;
        try (Cursor cursor = getContentResolver().query(pendingUri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        }
        return new JSONObject().put("name", name).put("size", size).put("url", ORIGIN + "/native/" + pendingToken).toString();
    }

    private void receiveIntent(Intent intent) {
        Uri uri = intent.getData();
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && uri != null && "content".equals(uri.getScheme())) { pendingUri = uri; pendingToken = UUID.randomUUID().toString(); }
    }
    private void notifyImport() { if (pendingUri != null) web.evaluateJavascript("window.dispatchEvent(new Event('omni-import'))", null); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); receiveIntent(intent); notifyImport(); }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('omni-system-theme'))", null);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILE && chooser != null) {
            Uri[] values = null;
            if (result == RESULT_OK && data != null) {
                ClipData clips = data.getClipData();
                if (clips != null) { values = new Uri[Math.min(clips.getItemCount(), 20)]; for (int i = 0; i < values.length; i++) values[i] = clips.getItemAt(i).getUri(); }
                else if (data.getData() != null) values = new Uri[] { data.getData() };
            }
            chooser.onReceiveValue(values); chooser = null;
        }
        if (request == SAVE_FILE) {
            if (result == RESULT_OK && data != null && data.getData() != null && exportFile != null) {
                Uri target = data.getData(); File source = exportFile;
                new Thread(() -> {
                    try (InputStream input = new FileInputStream(source); OutputStream output = getContentResolver().openOutputStream(target, "w")) {
                        if (output == null) throw new IOException("Нет доступа к выбранному месту.");
                        byte[] buffer = new byte[65536]; int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                        runOnUiThread(() -> toast("Файл сохранён."));
                    } catch (Exception error) { runOnUiThread(() -> toast("Не удалось сохранить файл.")); }
                    finally { runOnUiThread(() -> { saving = false; closeExport(); }); }
                }).start();
            } else { saving = false; closeExport(); }
        }
    }
    private void closeExport() {
        try { if (exportStream != null) exportStream.close(); } catch (IOException ignored) {}
        exportStream = null;
        if (exportFile != null) exportFile.delete();
        exportFile = null;
    }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    @Override public void onBackPressed() { web.evaluateJavascript("(function(){var dialog=document.querySelector('dialog[open]');if(dialog){dialog.close('cancel');return 'stay';}if(document.body.classList.contains('focus-mode')){document.getElementById('focus-exit').click();return 'stay';}if(!document.getElementById('reader').hidden){document.getElementById('close').click();return 'stay';}return 'exit';})()", result -> { if ("\"exit\"".equals(result)) finish(); }); }
    @Override protected void onDestroy() { if (chooser != null) chooser.onReceiveValue(null); if (!saving) closeExport(); closePdf(); web.destroy(); super.onDestroy(); }
}
