CREATE TABLE `iam_policy` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`document` text NOT NULL,
	`managed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `iam_role` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `iam_role_policy` (
	`role` text NOT NULL,
	`policy` text NOT NULL,
	PRIMARY KEY(`role`, `policy`),
	FOREIGN KEY (`role`) REFERENCES `iam_role`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy`) REFERENCES `iam_policy`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `iam_root` (
	`user_id` integer PRIMARY KEY NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `iam_user_role` (
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`user_id`, `role`, `source`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role`) REFERENCES `iam_role`(`name`) ON UPDATE no action ON DELETE no action
);
