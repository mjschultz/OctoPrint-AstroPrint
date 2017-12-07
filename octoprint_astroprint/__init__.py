# coding=utf-8
from __future__ import absolute_import


__author__ = "AstroPrint Product Team <product@astroprint.com>"
__license__ = "GNU Affero General Public License http://www.gnu.org/licenses/agpl.html"
__copyright__ = "Copyright (C) 2017 3DaGoGo, Inc - Released under terms of the AGPLv3 License"

from .AstroprintCloud import AstroprintCloud
from flask import request, Blueprint, make_response, jsonify, Response, abort
from threading import Timer
import octoprint.plugin
import json
import sys
import socket
from octoprint.server.util.flask import restricted_access
from octoprint.server import admin_permission
from octoprint.settings import valid_boolean_trues
from octoprint.users import SessionUser
from watchdog.observers import Observer
import re
from flask.ext.login import user_logged_in, user_logged_out
from octoprint.filemanager.destinations import FileDestinations
from octoprint.events import Events
from .cameramanager import cameraManager
from .materialcounter import MaterialCounter
from .printerlistener import PrinterListener

NO_CONTENT = ("", 204)
OK = ("", 200)


class JsonEncoder(json.JSONEncoder):
    def default(self, obj):
        return obj.__dict__

def getJsonCommandFromRequest(request, valid_commands):
	if not "application/json" in request.headers["Content-Type"]:
		return None, None, make_response("Expected content-type JSON", 400)

	data = request.json
	if not "command" in data.keys() or not data["command"] in valid_commands.keys():
		return None, None, make_response("Expected valid command", 400)

	command = data["command"]
	for parameter in valid_commands[command]:
		if not parameter in data:
			return None, None, make_response("Mandatory parameter %s missing for command %s" % (parameter, command), 400)

	return command, data, None

def create_ws_token(public_key= None):
	from itsdangerous import URLSafeTimedSerializer

	s = URLSafeTimedSerializer(octoprint.server.UI_API_KEY)
	return s.dumps({ 'public_key': public_key })


class AstroprintPlugin(octoprint.plugin.SettingsPlugin,
                       octoprint.plugin.AssetPlugin,
					   octoprint.plugin.StartupPlugin,
                       octoprint.plugin.TemplatePlugin,
					   octoprint.plugin.BlueprintPlugin,
					   octoprint.plugin.EventHandlerPlugin,
					   octoprint.printer.PrinterCallback):

	##~~ SettingsPlugin mixin
	user = None
	designs = None
	astroprintCloud = None
	cameraManager = None
	materialCounter= None
	_printerListener = None
	access_key = None

	def __init__(self):
		def logOutHandler(sender, **kwargs):
			self.onLogout()

		def logInHandler(sender, **kwargs):
			for key, value in kwargs.iteritems():
				if isinstance(value, SessionUser):
					self.onLogin()

		self.logOutHandler = logOutHandler
		self.logInHandler = logInHandler

		user_logged_in.connect(logInHandler)
		user_logged_out.connect(logOutHandler)

	def on_after_startup(self):
		self.register_printer_listener()
		self.cameraManager = cameraManager(self)
		self.astroprintCloud = AstroprintCloud(self)
		self.materialCounter = MaterialCounter(self)

	def onLogout(self):
		self.send_event("userLoggedOut", True)

	def onLogin(self):
		self.send_event("userLogged", True)

	def on_shutdown(self):
		#clear al process we created
		self.cameraManager.shutdown()
		self.astroprintCloud.downloadmanager.shutdown()
		self.unregister_printer_listener()

	def get_logger(self):
		return self._logger

	def get_printer(self):
		return self._printer

	def get_printer_listener(self):
		return self._printerListener

	def get_settings(self):
		return self._settings

	def get_plugin_version(self):
		return self._plugin_version

	def get_file_manager(self):
		return self._file_manager

	def sendSocketInfo(self):
		data = {
			'heatingUp' : self.printerIsHeating(),
			'currentLayer' : self._printerListener.get_current_layer() if self._printerListener else None,
			'camera' : self.cameraManager.cameraActive if self.cameraManager else None,
			'userLogged' : self.user.email if self.user else None,
			'job' : self._printerListener.get_job_data() if self._printerListener else None
		}
		self.send_event("socketUpdate", data)

	def astroPrintUserLoggedOut(self):
		self.send_event("astroPrintUserLoggedOut")

	def send_event(self, event, data=None):
		event = {'event':event, 'data':data}
		self._plugin_manager.send_plugin_message(self._plugin_name, event)

	def get_settings_defaults(self):

		appSite ="https://cloud.astroprint.com"
		appId="c4f4a98519194176842567680239a4c3"
		apiHost="https://api.astroprint.com/v2"
		webSocket="wss://boxrouter.astroprint.com"
		product_variant_id = "9e33c7a4303348e0b08714066bcc2750"


		return dict(
			#AstroPrintEndPoint
			appSite = appSite,
			appId = appId,
			apiHost = apiHost,
			webSocket = webSocket,
			product_variant_id = product_variant_id,
			#Remote Control settings
			access_control_enabled = True, #Only availible when octoprint access control is enabled
			allow_cross_origin = True,
			#
			camera = False,
			#Adittional printer settings
			max_nozzle_temp = 280, #only for being set by AstroPrintCloud, it wont affect octoprint settings
			max_bed_temp = 140,
		)

	def get_template_vars(self):

		return dict(appSite = self._settings.get(["appSite"]),
					appId = self._settings.get(["appId"]),
					appiHost = self._settings.get(["apiHost"]),
					user = json.dumps({'name': self.user.name, 'email': self.user.email}, cls=JsonEncoder, indent=4) if self.user else None ,
					camera = self._settings.get(["camera"])
					)


	def get_template_configs(self):
		return [
			dict(type="navbar", custom_bindings=False),
			dict(type="settings", custom_bindings=True)
		]

	##~~ AssetPlugin mixin

	def get_assets(self):
		# Define your plugin's asset files to automatically include in the
		# core UI here.
		return dict(
			js=["js/astroprint.js"],
			css=["css/astroprint.css"],
			less=["less/astroprint.less"]
		)

	##~~ Softwareupdate hook

	def get_update_information(self):
		# Define the configuration for your plugin to use with the Software Update
		# Plugin here. See https://github.com/foosel/OctoPrint/wiki/Plugin:-Software-Update
		# for details.
		return dict(
			astroprint=dict(
				displayName="AstroPrint",
				displayVersion=self._plugin_version,

				# version check: github repository
				type="github_release",
				user="AstroPrint",
				repo="OctoPrint-AstroPrint",
				current=self._plugin_version,

				# update method: pip
				pip="https://github.com/AstroPrint/OctoPrint-AstroPrint/archive/{target_version}.zip"
			)
		)

	def register_printer_listener(self):
		self._printerListener = PrinterListener(self)
		self._printer.register_callback(self._printerListener)

	def unregister_printer_listener(self):
		self._printer.unregister_callback(self._printerListener)
		self._printerListener = None

	def on_event(self, event, payload):

		printEvents = [
			Events.CONNECTED,
			Events.DISCONNECTED,
			Events.PRINT_STARTED,
			Events.PRINT_DONE,
			Events.PRINT_FAILED,
			Events.PRINT_CANCELLED,
			Events.PRINT_PAUSED,
			Events.PRINT_RESUMED,
			Events.ERROR,
		]

		cameraSuccessEvents = [
			Events.CAPTURE_DONE,
			Events.POSTROLL_END,
			Events.MOVIE_RENDERING,
			Events.MOVIE_DONE,
		]

		cameraFailEvents = [
			Events.CAPTURE_FAILED,
			Events.MOVIE_FAILED
		]

		if event in cameraSuccessEvents:
			self.cameraManager.cameraConnected()

		elif event in cameraFailEvents:
			self.cameraManager.cameraError()

		elif event == Events.FILE_REMOVED:
			if payload['storage'] == 'local':
				self.astroprintCloud.db.deletePrintFile(payload['path'])

		elif event == Events.CONNECTED:
			self.send_event("canPrint", True)

		elif event == Events.PRINT_CANCELLED or event == Events.PRINT_FAILED:
			self.send_event("canPrint", True)
			if self.user:
				self.astroprintCloud.updatePrintJob("failed", self.materialCounter.totalConsumedFilament)
			self.astroprintCloud.currentlyPrinting = None
			self.cameraManager.stop_timelapse()
			self._analyzed_job_layers = None

		elif event == Events.PRINT_DONE:
			if self.user and self.astroprintCloud.currentlyPrinting:
				self.astroprintCloud.updatePrintJob("success", self.materialCounter.totalConsumedFilament)
			self.astroprintCloud.currentlyPrinting = None
			self.cameraManager.stop_timelapse()
			self.send_event("canPrint", True)

		elif event == Events.PRINT_STARTED:
			self.send_event("canPrint", False)
			if self.user:
				self.astroprintCloud.printStarted(payload['name'], payload['path'])

			self.materialCounter.startPrint()
			self._printerListener.startPrint(payload['file'])
		if  event in printEvents:
			self.sendSocketInfo()
			if self.user:
				self.astroprintCloud.sendCurrentData()

		return

	def printerIsHeating(self):
		heating = False
		if self._printer.is_operational():
			heating = self._printer._comm._heating

		return heating

	def count_material(self, comm_instance, phase, cmd, cmd_type, gcode, *args, **kwargs):
		if self.materialCounter:
			gcodeHandler = "_gcode_" + gcode
			if hasattr(self.materialCounter, gcodeHandler):
				materialCounter = getattr(self.materialCounter, gcodeHandler,None)
				materialCounter(cmd)


	def is_blueprint_protected(self):
		return False

	@octoprint.plugin.BlueprintPlugin.route("/saveAccessKey", methods=["POST"])
	@restricted_access
	def saveAccessKey(self):
		access_key = request.json['access_key']
		print access_key
		self.access_key = access_key
		return jsonify({"success" : True }), 200, {'ContentType':'application/json'}

	@octoprint.plugin.BlueprintPlugin.route("/loggin", methods=["POST"])
	@restricted_access
	@admin_permission.require(403)
	def loggin(self):
		code = request.json['code']
		url = request.json['url']
		return self.astroprintCloud.logAstroPrint(code, url)

	@octoprint.plugin.BlueprintPlugin.route("/logout", methods=["POST"])
	@restricted_access
	@admin_permission.require(403)
	def logout(self):
		return self.astroprintCloud.logoutAstroPrint()


	@octoprint.plugin.BlueprintPlugin.route("/designs", methods=["GET"])
	@restricted_access
	@admin_permission.require(403)
	def getDesigns(self):
		return self.astroprintCloud.getDesigns()

	@octoprint.plugin.BlueprintPlugin.route("/printfiles", methods=["GET"])
	@restricted_access
	@admin_permission.require(403)
	def getPrintFiles(self):
		designId = request.args.get('designId', None)
		return self.astroprintCloud.getPrintFiles(designId)

	@octoprint.plugin.BlueprintPlugin.route("/downloadDesign", methods=["POST"])
	@restricted_access
	@admin_permission.require(403)
	def downloadDesign(self):
		designId = request.json['designId']
		name = request.json['name']
		return self.astroprintCloud.getDesignDownloadUrl(designId, name)

	@octoprint.plugin.BlueprintPlugin.route("/downloadPrintFile", methods=["POST"])
	@restricted_access
	@admin_permission.require(403)
	def downloadPrintFile(self):
		printFileId = request.json['printFileId']
		if self.astroprintCloud.printFile(printFileId) == "print":
			return jsonify({"state" : "printing"}), 200, {'ContentType':'application/json'}
		if self.astroprintCloud.printFile(printFileId) == "download":
			return jsonify({"state" : "downloading"}), 200, {'ContentType':'application/json'}
		return jsonify({'error': "Internal server error"}), 500, {'ContentType':'application/json'}

	@octoprint.plugin.BlueprintPlugin.route("/canceldownload", methods=["POST"])
	@restricted_access
	@admin_permission.require(403)
	def canceldownload(self):
		id = request.json['id']
		self.astroprintCloud.downloadmanager.cancelDownload(id)
		return jsonify({"success" : True }), 200, {'ContentType':'application/json'}

	@octoprint.plugin.BlueprintPlugin.route("/checkcamerastatus", methods=["GET"])
	@restricted_access
	@admin_permission.require(403)
	def checkcamerastatus(self):
		self.cameraManager.checkCameraStatus()
		return jsonify({"connected" : True if self.cameraManager.cameraActive else False }), 200, {'ContentType':'application/json'}

	@octoprint.plugin.BlueprintPlugin.route("/isloggeduser", methods=["GET"])
	@restricted_access
	@admin_permission.require(403)
	def isloggeduser(self):
		if self.user:
			return jsonify({"user" : {"name" : self.user.name, "email" : self.user.email}}), 200, {'ContentType':'application/json'}
		else:
			return jsonify({"user" : False }), 200, {'ContentType':'application/json'}

	@octoprint.plugin.BlueprintPlugin.route("/iscameraconnected", methods=["GET"])
	@restricted_access
	@admin_permission.require(403)
	def iscameraconnected(self):
		return jsonify({"connected" : True if self.cameraManager.cameraActive else False }), 200, {'ContentType':'application/json'}

	@octoprint.plugin.BlueprintPlugin.route("/initialstate", methods=["GET"])
	@restricted_access
	@admin_permission.require(403)
	def initialstate(self):
		return jsonify({
					"user" : {"name" : self.user.name, "email" : self.user.email} if self.user else False,
					"connected" : True if self.cameraManager.cameraActive else False,
					"can_print" : True if self._printer.is_operational() and not (self._printer.is_paused() or self._printer.is_printing()) else False
					}), 200, {'ContentType':'application/json'}

	##LOCAL AREA
	#Functions related to local aspects

	@octoprint.plugin.BlueprintPlugin.route("/astrobox/identify", methods=["GET"])
	def identify(self):
		return Response(json.dumps({
			'id': self.astroprintCloud.bm.boxId,
			'name': socket.gethostname(),
			'version': self._plugin_version,
			'firstRun': True if self._settings.global_get_boolean(["server", "firstRun"]) else None,
			'online': True,
		})
		)

	@octoprint.plugin.BlueprintPlugin.route("/accessKeys", methods=["POST"])
	def getAccessKeys(self):
		publicKey = None
		email = request.values.get('email', None)
		accessKey = request.values.get('accessKey', None)

		userLogged = self.user.email if self.user else None
		userAccessKey = self.user.accessKey if self.user else None

		####
		# - nobody logged: None
		# - any log: email

		if email and accessKey:#somebody is logged in the remote client
			if userLogged and userAccessKey:#Somebody logged in AstroPrint plugin
				if userLogged == email and userAccessKey == accessKey:#I am the user logged

					publicKey = self.user.userId

					if not publicKey:
						abort(403)

				else:#I am NOT the logged user
					abort(403)
			elif  (self._settings.global_get_boolean(['accessControl', 'enabled']) and self._settings.get_boolean(["access_control_enabled"])):
				abort(403)

		else:#nodody is logged in the remote client
			if userLogged or (self._settings.global_get_boolean(['accessControl', 'enabled']) and self._settings.get_boolean(["access_control_enabled"])):
				abort(401)

		return Response(
			json.dumps({
				'api_key': self._settings.global_get(["api", "key"]),
				'ws_token': create_ws_token(publicKey)
			}),
			mimetype= 'application/json'
		)

	@octoprint.plugin.BlueprintPlugin.route("/status", methods=["GET"])
	@restricted_access
	def getStatus(self):

		fileName = None

		if self._printer.is_printing():
			currentJob = self._printer.get_current_job()
			fileName = currentJob["file"]["name"]

		return Response(
			json.dumps({
				'id': self.astroprintCloud.bm.boxId,
				'name': socket.gethostname(),
				'printing': self._printer.is_printing(),
				'fileName': fileName,
				'printerModel': None,
				'material': None,
				'operational': self._printer.is_operational(),
				'paused': self._printer.is_paused(),
				'camera': self.cameraManager.cameraActive,
				'remotePrint': True,
				'capabilities': ['remotePrint'] + self.cameraManager.capabilities
			}),
			mimetype= 'application/json'
		)

	@octoprint.plugin.BlueprintPlugin.route("/api/printer-profile", methods=["GET"])
	@restricted_access
	def printer_profile_patch(self):
		printerProfile = self._printer.get_current_connection()[3]
		profile = {
			'driver': "marlin", #At the moment octopi only supports marlin
			'extruder_count': printerProfile['extruder']['count'],
			'max_nozzle_temp': self._settings.get(["max_nozzle_temp"]),
			'max_bed_temp': self._settings.get(["max_bed_temp"]),
			'heated_bed': printerProfile['heatedBed'],
			'cancel_gcode': ['G28 X0 Y0'],#ToDo figure out how to get it from snipet
			'invert_z': printerProfile['axes']['z']['inverted'],
		}
		return jsonify(profile)



	@octoprint.plugin.BlueprintPlugin.route("/api/printer/fan", methods=["POST"])
	def printerFanCommand(self):

		if not self._printer.is_operational():
			return make_response("Printer is not operational", 409)

		valid_commands = {
			"set": ["tool", "speed"]
		}

		command, data, response = getJsonCommandFromRequest(request, valid_commands)
		if response is not None:
			return response

		self._printer.command("M106 S%d" % max(data["speed"], data["speed"]))

		return NO_CONTENT

	@octoprint.plugin.BlueprintPlugin.route('/camera/snapshot', methods=["GET"])
	@restricted_access
	def camera_snapshot(self):
		pic_buf = self.cameraManager.getPic()
		if pic_buf:
			return Response(pic_buf, mimetype='image/jpeg')
		else:
			return 'Camera not ready', 404


	@octoprint.plugin.BlueprintPlugin.route('/api/astroprint', methods=['DELETE'])
	@restricted_access
	def astroPrint_logout(self):
		return self.astroprintCloud.logoutAstroPrint()

	@octoprint.plugin.BlueprintPlugin.route('/api/job', methods=['POST'])
	@restricted_access
	def controlJob(self):

		if not self._printer.is_operational():
			return make_response("Printer is not operational", 409)

		valid_commands = {
			"start": [],
			"restart": [],
			"pause": [],
			"cancel": []
		}

		command, data, response = getJsonCommandFromRequest(request, valid_commands)
		if response is not None:
			return response

		activePrintjob = self._printer.is_printing() or self._printer.is_paused()

		if command == "start":
			if activePrintjob:
				return make_response("Printer already has an active print job, did you mean 'restart'?", 409)
			self._printer.start_print()
		elif command == "restart":
			if not self._printer.is_paused():
				return make_response("Printer does not have an active print job or is not paused", 409)
			self._printer.start_print()
		elif command == "pause":
			if not activePrintjob:
				return make_response("Printer is neither printing nor paused, 'pause' command cannot be performed", 409)
			self._printer.toggle_pause_print()
		elif command == "cancel":
			if not activePrintjob:
				response = make_response(json.dumps({
					'id': 'no_active_print',
					'msg': "Printer is neither printing nor paused, 'cancel' command cannot be performed"
				}), 409)
				response.headers['Content-Type'] = 'application/json'
				return response
			self._printer.cancel_print()


		return NO_CONTENT

	@octoprint.plugin.BlueprintPlugin.route('/api/job', methods=['GET'])
	def jobState():
		currentData = self._printer.get_current_data()
		return jsonify({
			"job": currentData["job"],
			"progress": currentData["progress"],
			"state": currentData["state"]["text"]
		})

# If you want your plugin to be registered within OctoPrint under a different name than what you defined in setup.py
# ("OctoPrint-PluginSkeleton"), you may define that here. Same goes for the other metadata derived from setup.py that
# can be overwritten via __plugin_xyz__ control properties. See the documentation for that.
__plugin_name__ = "Astroprint"

def __plugin_load__():
	global __plugin_implementation__
	__plugin_implementation__ = AstroprintPlugin()

	global __plugin_hooks__
	__plugin_hooks__ = {
		"octoprint.plugin.softwareupdate.check_config": __plugin_implementation__.get_update_information,
		"octoprint.comm.protocol.gcode.sent": __plugin_implementation__.count_material
	}
