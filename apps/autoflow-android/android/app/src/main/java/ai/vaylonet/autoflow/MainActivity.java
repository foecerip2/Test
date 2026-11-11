package ai.vaylonet.autoflow;

import com.getcapacitor.BridgeActivity;

/**
 * Оболочка AutoFlow: открывает сайт из capacitor.config (server.url), навигация разрешена только на его домен
 * (server.allowNavigation). Диалога basic-auth здесь нет: он нужен только LeadHunter.
 */
public class MainActivity extends BridgeActivity {}
