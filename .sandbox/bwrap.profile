# bubblewrap 默认沙箱 profile
# 每行一个参数，sandbox-run.ts 会解析此文件并拼接 bwrap 命令行

--unshare-all
--share-net-disabled
--ro-bind
/
/
--proc
/proc
--dev
/dev
--tmpfs
/tmp
--cap-drop
ALL
--die-with-parent
