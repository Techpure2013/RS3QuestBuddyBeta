const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const path = require("path");
const webpack = require("webpack");
const CopyWebpackPlugin = require("copy-webpack-plugin");

const isElectron = process.env.BUILD_TARGET === "electron";

// Electron main process config (uiboot)
const electronMainConfig = {
	name: "electron-main",
	context: path.resolve(__dirname, "src/gl"),
	target: "electron-main",
	mode: "development",
	devtool: false,
	entry: {
		uiboot: "./uiboot.ts",
	},
	output: {
		globalObject: "globalThis",
		filename: "[name].bundle.js",
		path: path.resolve(__dirname, "dist"),
	},
	resolve: {
		extensions: [".ts", ".js"],
	},
	externals: [
		async function ({ request }) {
			let whitelist = [
				"electron",
				"electron/common",
				"electron/renderer",
				"child_process",
				"fs",
				"path",
				"util",
			];
			if (whitelist.indexOf(request) != -1) {
				return `(typeof require != "undefined" ? require("${request}") : null)`;
			}
		},
	],
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				use: {
					loader: "ts-loader",
					options: {
						transpileOnly: true,
					},
				},
				exclude: /node_modules/,
			},
			{
				test: /\.glsl$/,
				type: "asset/source",
			},
		],
	},
	plugins: [],
};

// Renderer config (main app)
const rendererConfig = {
	name: "renderer",
	context: path.resolve(__dirname, "src"),
	target: isElectron ? "electron-renderer" : "web",
	entry: {
		main: "./Entrance/index.tsx",
	},
	output: {
		globalObject: "globalThis",
		path: path.resolve(__dirname, "dist"),
		filename: isElectron ? "js/[name].bundle.js" : "js/[name].[contenthash].bundle.js",
		chunkFilename: isElectron ? "js/[name].chunk.js" : "js/[name].[contenthash].chunk.js",
		publicPath: "./",
		clean: false,
	},
	devtool: "source-map",
	mode: "development",
	devServer: {
		static: {
			directory: path.resolve(__dirname, "dist"),
		},
		port: 3001,
		host: "127.0.0.1",
		open: true,
		hot: true,
		historyApiFallback: true,
		proxy: [
			{
				context: ["/api"],
				target: "http://127.0.0.1:42069",
				changeOrigin: true,
			},
			{
				context: ["/images"],
				target: "https://techpure.dev",
				changeOrigin: true,
				secure: true,
			},
		],
	},
	resolve: {
		mainFields: ["browser", "module", "main"],
		extensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
		alias: {
			"@injection": path.resolve(__dirname, "src/gl/injection"),
		},
		fallback: isElectron ? {} : {
			fs: false,
			path: require.resolve("path-browserify"),
			os: require.resolve("os-browserify/browser"),
			stream: require.resolve("stream-browserify"),
			child_process: false,
		},
	},
	externals: isElectron ? [
		{
			canvas: "null",
			sharp: "null",
		},
		async function ({ request }) {
			let whitelist = [
				"electron",
				"electron/common",
				"electron/renderer",
				"child_process",
				"fs",
				"path",
				"util",
			];
			if (whitelist.indexOf(request) != -1) {
				return `(typeof require != "undefined" ? require("${request}") : null)`;
			}
		},
	] : {
		sharp: "commonjs sharp",
	},
	optimization: {
		splitChunks: {
			chunks: "all",
			cacheGroups: {
				vendor: {
					test: /[\\/]node_modules[\\/]/,
					name: "vendors",
					priority: 10,
				},
				common: {
					minChunks: 2,
					priority: 5,
					reuseExistingChunk: true,
				},
			},
		},
		runtimeChunk: "single",
	},
	module: {
		rules: [
			{
				test: /\.(png|jpg|jpeg|gif|webp)$/i,
				type: "asset/resource",
				generator: {
					filename: "./assets/[name][ext]",
				},
			},
			{
				test: /\.jsx?$/,
				exclude: /node_modules/,
				use: {
					loader: "babel-loader",
					options: {
						presets: [
							[
								"@babel/preset-env",
								{
									modules: false,
									targets: {
										browsers: [">0.25%", "not dead"],
									},
								},
							],
							"@babel/preset-react",
						],
						plugins: [
							"@babel/plugin-syntax-dynamic-import",
						],
					},
				},
			},
			{
				test: /\.tsx?$/,
				use: {
					loader: "ts-loader",
					options: {
						transpileOnly: true,
					},
				},
				exclude: /node_modules/,
			},
			{
				test: /\.css$/,
				use: [
					MiniCssExtractPlugin.loader,
					{
						loader: "css-loader",
						options: {
							url: false,
						},
					},
				],
			},
			{
				test: /\.scss$/,
				use: [
					MiniCssExtractPlugin.loader,
					{
						loader: "css-loader",
						options: {
							url: true,
						},
					},
					"sass-loader",
				],
			},
			{
				test: /\.(woff|woff2|eot|ttf|otf)$/i,
				type: "asset/resource",
				generator: {
					filename: "./assets/fonts/[name][ext]",
				},
			},
			{
				test: /\.(ogg|mp3|wav)$/,
				type: "asset/resource",
				generator: {
					filename: "./assets/audio/[name][ext]",
				},
			},
			{
				test: /\.glsl$/,
				type: "asset/source",
			},
		],
	},
	plugins: [
		new webpack.DefinePlugin({
			__EDITOR_BASE_URL__: JSON.stringify(
				process.env.EDITOR_BASE_URL || "http://127.0.0.1:3000/RS3QuestBuddyEditor",
			),
			__REACT_DEVTOOLS_GLOBAL_HOOK__: "({ isDisabled: true })",
		}),
		new MiniCssExtractPlugin({
			filename: isElectron ? "assets/css/[name].css" : "assets/css/[name].[contenthash].css",
			chunkFilename: isElectron ? "assets/css/[name].chunk.css" : "assets/css/[name].[contenthash].chunk.css",
		}),
		new HtmlWebpackPlugin({
			template: "./Entrance/index.html",
			filename: "index.html",
			inject: true,
		}),
		new webpack.IgnorePlugin({
			resourceRegExp: /^(canvas|electron\/common|sharp)$/,
		}),
		new CopyWebpackPlugin({
			patterns: [
				{ from: "public", to: "." },
				{ from: "assets", to: "assets" },
				{ from: "appconfig.prod.json", to: "appconfig.prod.json" },
				{
					from: "appconfig.local.json",
					to: "appconfig.local.json",
					noErrorOnMissing: true,
				},
			],
		}),
	],
};

// Controlpanel config (GL debug tool - only for Electron)
const controlpanelConfig = {
	name: "controlpanel",
	context: path.resolve(__dirname, "ts"),
	target: "electron-renderer",
	mode: "development",
	devtool: "source-map",
	entry: {
		controlpanel: "./controlpanel/index.tsx",
	},
	output: {
		globalObject: "globalThis",
		filename: "[name].bundle.js",
		path: path.resolve(__dirname, "dist/controlpanel"),
		publicPath: "./",
	},
	resolve: {
		extensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
		alias: {
			"@injection": path.resolve(__dirname, "ts"),
		},
	},
	externals: [
		{
			canvas: "null",
			sharp: "null",
		},
		async function ({ request }) {
			let whitelist = [
				"electron",
				"electron/common",
				"electron/renderer",
				"child_process",
				"fs",
				"path",
				"util",
			];
			if (whitelist.indexOf(request) != -1) {
				return `(typeof require != "undefined" ? require("${request}") : null)`;
			}
		},
	],
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				use: {
					loader: "ts-loader",
					options: {
						transpileOnly: true,
						configFile: path.resolve(__dirname, "tsconfig.json"),
					},
				},
				exclude: /node_modules/,
			},
			{
				test: /\.css$/,
				use: [
					"style-loader",
					{
						loader: "css-loader",
						options: {
							url: false,
						},
					},
				],
			},
			{
				test: /\.scss$/,
				use: [
					"style-loader",
					{
						loader: "css-loader",
						options: {
							url: true,
						},
					},
					"sass-loader",
				],
			},
			{
				test: /\.(png|jpg|jpeg|gif|webp)$/i,
				type: "asset/resource",
				generator: {
					filename: "[name][ext]",
				},
			},
			{
				test: /\.glsl$/,
				type: "asset/source",
			},
		],
	},
	plugins: [
		new HtmlWebpackPlugin({
			template: "./controlpanel/index.html",
			filename: "index.html",
			inject: true,
			scriptLoading: "blocking",
		}),
		new CopyWebpackPlugin({
			patterns: [
				{ from: "./controlpanel/appconfig.json", to: "appconfig.json" },
				{ from: "./controlpanel/appicon.png", to: "appicon.png" },
			],
		}),
	],
};

// Export based on build target
module.exports = isElectron ? [electronMainConfig, rendererConfig] : rendererConfig;
