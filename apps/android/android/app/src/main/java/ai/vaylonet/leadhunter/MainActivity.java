package ai.vaylonet.leadhunter;

import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.HttpAuthHandler;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.LinearLayout;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    private static final String SITE_HOST = "ai.vaylonet.ru";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final WebView web = getBridge().getWebView();
        web.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public void onReceivedHttpAuthRequest(final WebView view, final HttpAuthHandler handler, final String host, final String realm) {
                // Учётные данные запрашиваем только для своего сайта.
                if (!SITE_HOST.equals(host)) {
                    handler.cancel();
                    return;
                }
                if (handler.useHttpAuthUsernamePassword()) {
                    String[] saved = view.getHttpAuthUsernamePassword(host, realm);
                    if (saved != null && saved.length == 2 && saved[0] != null && saved[1] != null) {
                        handler.proceed(saved[0], saved[1]);
                        return;
                    }
                }
                showLoginDialog(view, handler, host, realm);
            }
        });
        // Первый запрос мог уйти до подмены клиента — перезагружаем, чтобы пройти вход.
        web.post(new Runnable() {
            @Override
            public void run() {
                web.reload();
            }
        });
    }

    private void showLoginDialog(final WebView view, final HttpAuthHandler handler, final String host, final String realm) {
        final int pad = (int) (20 * getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);
        final EditText user = new EditText(this);
        user.setHint("Логин");
        user.setInputType(InputType.TYPE_CLASS_TEXT);
        final EditText pass = new EditText(this);
        pass.setHint("Пароль");
        pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(user);
        box.addView(pass);
        new AlertDialog.Builder(this)
            .setTitle("Вход на сайт")
            .setMessage(host)
            .setView(box)
            .setCancelable(false)
            .setPositiveButton("Войти", (d, w) -> {
                String u = user.getText().toString();
                String p = pass.getText().toString();
                view.setHttpAuthUsernamePassword(host, realm, u, p);
                handler.proceed(u, p);
            })
            .setNegativeButton("Отмена", (d, w) -> handler.cancel())
            .show();
    }
}
