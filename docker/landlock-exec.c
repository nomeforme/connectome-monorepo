/**
 * landlock-exec — Apply Landlock filesystem restrictions then exec the given command.
 *
 * Usage: landlock-exec <command> [args...]
 *
 * Read-write: /tmp, /workspace/shared, /home/coder
 * Read-only:  everything else the process currently has access to
 *
 * Falls back gracefully if Landlock is not supported (kernel < 5.13 or
 * not enabled). Applies PR_SET_NO_NEW_PRIVS before Landlock.
 *
 * Compile: gcc -O2 -o landlock-exec landlock-exec.c
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Landlock ABI v2 access flags */
#define ACCESS_FS_ROUGHLY_READ ( \
    LANDLOCK_ACCESS_FS_EXECUTE | \
    LANDLOCK_ACCESS_FS_READ_FILE | \
    LANDLOCK_ACCESS_FS_READ_DIR )

#define ACCESS_FS_ROUGHLY_WRITE ( \
    LANDLOCK_ACCESS_FS_WRITE_FILE | \
    LANDLOCK_ACCESS_FS_REMOVE_DIR | \
    LANDLOCK_ACCESS_FS_REMOVE_FILE | \
    LANDLOCK_ACCESS_FS_MAKE_CHAR | \
    LANDLOCK_ACCESS_FS_MAKE_DIR | \
    LANDLOCK_ACCESS_FS_MAKE_REG | \
    LANDLOCK_ACCESS_FS_MAKE_SOCK | \
    LANDLOCK_ACCESS_FS_MAKE_FIFO | \
    LANDLOCK_ACCESS_FS_MAKE_BLOCK | \
    LANDLOCK_ACCESS_FS_MAKE_SYM )

/* Syscall wrappers (not in glibc yet) */
static inline int landlock_create_ruleset(
    const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
    return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static inline int landlock_add_rule(
    int ruleset_fd, enum landlock_rule_type type,
    const void *attr, __u32 flags) {
    return (int)syscall(__NR_landlock_add_rule, ruleset_fd, type, attr, flags);
}

static inline int landlock_restrict_self(int ruleset_fd, __u32 flags) {
    return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

/* Add a path rule to the ruleset */
static int add_path_rule(int ruleset_fd, const char *path, __u64 access) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        /* Path doesn't exist — skip silently */
        return 0;
    }
    struct landlock_path_beneath_attr attr = {
        .allowed_access = access,
        .parent_fd = fd,
    };
    int ret = landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0);
    close(fd);
    return ret;
}

/* Read-write paths */
static const char *rw_paths[] = {
    "/tmp",
    "/workspace/shared",
    "/home/coder",
    "/root/.pi",
    "/proc/self",
    NULL
};

/* Read-only paths */
static const char *ro_paths[] = {
    "/workspace",
    "/usr",
    "/lib",
    "/lib64",
    "/etc",
    "/dev",
    "/proc",
    "/sys",
    "/run/secrets",
    NULL
};

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: landlock-exec <command> [args...]\n");
        return 1;
    }

    /* Check Landlock ABI availability */
    int abi = landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0) {
        /* Landlock not available — proceed without it */
        fprintf(stderr, "[landlock-exec] Landlock not available (errno=%d), running unrestricted\n", errno);
        goto exec_child;
    }
    fprintf(stderr, "[landlock-exec] Landlock ABI v%d available\n", abi);

    /* Create ruleset with all filesystem access types */
    struct landlock_ruleset_attr ruleset_attr = {
        .handled_access_fs = ACCESS_FS_ROUGHLY_READ | ACCESS_FS_ROUGHLY_WRITE,
    };
    int ruleset_fd = landlock_create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
    if (ruleset_fd < 0) {
        fprintf(stderr, "[landlock-exec] Failed to create ruleset: %s\n", strerror(errno));
        goto exec_child;
    }

    /* Add read-write rules */
    for (int i = 0; rw_paths[i]; i++) {
        add_path_rule(ruleset_fd, rw_paths[i],
            ACCESS_FS_ROUGHLY_READ | ACCESS_FS_ROUGHLY_WRITE);
    }

    /* Add read-only rules */
    for (int i = 0; ro_paths[i]; i++) {
        add_path_rule(ruleset_fd, ro_paths[i], ACCESS_FS_ROUGHLY_READ);
    }

    /* Set no-new-privs (required for Landlock) */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
        fprintf(stderr, "[landlock-exec] prctl(NO_NEW_PRIVS) failed: %s\n", strerror(errno));
        close(ruleset_fd);
        goto exec_child;
    }

    /* Enforce */
    if (landlock_restrict_self(ruleset_fd, 0)) {
        fprintf(stderr, "[landlock-exec] landlock_restrict_self failed: %s\n", strerror(errno));
        close(ruleset_fd);
        goto exec_child;
    }
    close(ruleset_fd);
    fprintf(stderr, "[landlock-exec] Filesystem restrictions applied\n");

exec_child:
    execvp(argv[1], &argv[1]);
    fprintf(stderr, "[landlock-exec] exec failed: %s\n", strerror(errno));
    return 127;
}
