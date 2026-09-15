# Samsung S Pen Remote SDK v1.0.1

- `spenremote-v1.0.1.jar` — сам SDK (`com.samsung.android.sdk.penremote`)
- `sdk-v1.0.0.jar` — общий Samsung SDK (`SsdkVendorCheck`), от которого он зависит

Взято из `SpenRemoteSDK_v1.0.1.zip` с
[developer.samsung.com/galaxy-spen-remote](https://developer.samsung.com/galaxy-spen-remote/download.html).
Samsung не публикует SDK в Maven, поэтому файлы лежат прямо в репозитории —
иначе проект не собрался бы ни на CI, ни на чужой машине.

Gradle подхватывает любой `*.jar` и `*.aar` из этой папки автоматически.
