<?php
// Образец конфигурации ретранслятора. Копия должна называться lh-mail-config.php и лежать ВЫШЕ каталога сайта
// (скрипт ищет её в ../lh-mail-config.php). Права файла: 0600. setup.sh создаёт её сам.
return [
    // Общий секрет с сервером LeadHunter (MAIL_RELAY_SECRET), не короче 32 символов.
    'secret'        => 'ЗАМЕНИТЕ_НА_СЕКРЕТ_ИЗ_lh-config_mail-relay',

    // Транспорт: 'smtp' (по умолчанию) или 'mail' (функция mail() — запасной вариант).
    'transport'     => 'smtp',

    'smtp_host'     => 'mail.hosting.reg.ru',
    'smtp_port'     => 465,
    'smtp_security' => 'ssl',                 // ssl (465) | starttls (587)
    'smtp_user'     => 'noreply@vaylonet.ru', // полный адрес ящика
    'smtp_password' => 'ПАРОЛЬ_ЯЩИКА',
    'from'          => 'LeadHunter <noreply@vaylonet.ru>',

    // Каталог данных (nonce, лимиты, журнал) — вне каталога сайта; скрипт откажется работать, если он внутри.
    'data_dir'      => '/path/to/lh-mail-data',

    // Необязательные лимиты (по умолчанию 5 писем/час на получателя и 300/сутки всего):
    // 'max_per_recipient_per_hour' => 5,
    // 'max_per_day'                => 300,
];
