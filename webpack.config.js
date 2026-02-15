const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const path = require("path");
const webpack = require("webpack");
const CopyWebpackPlugin = require("copy-webpack-plugin");

// Renderer config (main app)
const rendererConfig = {
	name: "renderer",
	context: path.resolve(__dirname, "src"),
	target: "web",
	entry: {
		main: "./Entrance/index.tsx",
	},
	output: {
		globalObject: "globalThis",
		path: path.resolve(__dirname, "dist"),
		filename: "js/[name].[contenthash].bundle.js",
		chunkFilename: "js/[name].[contenthash].chunk.js",
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
				target: "https://techpure.dev",
				changeOrigin: true,
				secure: true,
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
		fallback: {
			fs: false,
			path: require.resolve("path-browserify"),
			os: require.resolve("os-browserify/browser"),
			stream: require.resolve("stream-browserify"),
			child_process: false,
		},
	},
	externals: {
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
			"process.env": JSON.stringify({
				NODE_ENV: process.env.NODE_ENV || "development",
				REACT_APP_API_URL: process.env.REACT_APP_API_URL || "",
			}),
		}),
		new MiniCssExtractPlugin({
			filename: "assets/css/[name].[contenthash].css",
			chunkFilename: "assets/css/[name].[contenthash].chunk.css",
		}),
		new HtmlWebpackPlugin({
			template: "./Entrance/index.html",
			filename: "index.html",
			inject: true,
		}),
		new webpack.IgnorePlugin({
			resourceRegExp: /^(canvas|sharp|electron(\/common)?)$/,
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

module.exports = rendererConfig;
