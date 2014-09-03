"use strict"
// Copyright (C) 2014 OneJS
//
//   Licensed under the Apache License, Version 2.0 (the "License");
//   you may not use this file except in compliance with the License.
//   You may obtain a copy of the License at
//       http://www.apache.org/licenses/LICENSE-2.0
//   Unless required by applicable law or agreed to in writing, software
//   distributed under the License is distributed on an "AS IS" BASIS,
//   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//   See the License for the specific language governing permissions and
//   limitations under the License.

// ONEJS boot up fabric for webbrowser

ONE.worker_boot_ = function(host){

	host.onmessage = function(event){
		var data = event.data
		if(!Array.isArray(data)) throw new Error('non array message received')
		for(var i = 0, l = data.length; i < l; i++){
			var msg = data[i]
			if(msg._type == 'signal'){ // we have to set a value
				var obj = host.proxy_obj[msg._uid]
				if(!obj) throw new Error('set on nonexistant object ' + msg._uid)
				obj[msg.name] = msg.value
			}
			else if(msg._type == 'call'){
				var obj = host.proxy_obj[msg._uid]
				if(!obj) throw new Error('Call on nonexistant object ' + msg._uid)
				if(msg.args) obj[msg.name].apply(obj, msg.args)
				else obj[msg.name].call(obj)
			}
			else if(msg._type == 'eval'){ // lets parse and eval a module
				var ast = ONE.root.__modules__['_' + msg.module]
				var dt = Date.now()
				if(!ast){
					return console.log('Module ' + msg.module + ' not parsed')
				}
				ONE.root.__modules__[msg.module] = ONE.root.eval(ast, msg.module)
				//console.log('eval '+msg.module+' '+(Date.now()-dt)+'ms')
			}
			else if(msg._type == 'parse'){
				var dt = Date.now()
				ONE.root.__modules__['_' + msg.module] = ONE.root.parse('->{' + msg.value + '\n}', msg.module)
				//console.log('parse '+msg.module+' '+(Date.now()-dt)+'ms')
			}
			else if(msg._type == 'run'){
				ONE.root.__modules__[msg.module].call(ONE.root)
			}
		}
		if(host.msg_queue.length) host.msgFlush()
	}

	// message queueing
	host.msg_start = 0
	host.msg_queue = []
	host.msgFlush = function(){
		this.postMessage(this.msg_queue)
		this.msg_start = Date.now()
		this.msg_queue = []
	}.bind(host)

	host.sendToHost = function(msg){
		var now = Date.now()
		//if(this.msg_queue.length && now - this.msg_start > 10){ // make sure we chunk every 20ms for parallelisation
		//	this.msg_queue.push(msg)
		//	this.msgFlush()
		//}
		//else{
			if(this.msg_queue.push(msg) == 1){
				this.msg_start = now
				setTimeout(this.msgFlush, 0)
			}
		//}
	}

	host.proxy_obj = {}

	ONE.proxify = function(){
		var list = ONE.proxify_list
		ONE.proxify_list = []
		for(var i = 0, l = list.length; i<l; i++){
			list[i]._proxify()
		}
	}

	ONE.proxify_list = []
	ONE.proxy_uid = 1
	ONE.proxy_free = []

	ONE.host = host

	ONE.init()
	ONE.init_ast()
	ONE.root = ONE.Base.new()
	ONE.root.__class__ = 'Root'
}

ONE.proxy_ = function(){

	// baseclass for the worker objects
	this.Base.WorkerProxy = this.Base.extend(function(){
		this.__proxy__ = 0
		this.__class__ = 'WorkerProxy'

		// used to minimize compilation
		this.__proxy_cache__ = {}

		// called when someone makes an instance
		this._init = function(){
			if(!ONE.proxy_free.length) this.__proxy__ = ONE.proxy_uid++
			else this.__proxy__ = ONE.proxy_free.pop()
			this.defineProperty('__proxy__', { enumerable:false, configurable:true })
			// store it
			ONE.host.proxy_obj[this.__proxy__] = this

			// queue up our object proxify
			if(ONE.proxify_list.push(this) == 1){
				setTimeout(ONE.proxify, 0)
			}
		}
		
		// make sure extend pre and post dont fire on us
		var blockPrePost = this

		// called in .extend to make sure we proxify before being used
		// this is necessary otherwise the getter/setter layer never works
		this._extendPre = function(){
			if(this == blockPrePost) return // make sure our current.extend doesnt trigger us
			if(!ONE.proxy_free.length) this.__proxy__ = ONE.proxy_uid++
			else this.__proxy__ = ONE.proxy_free.pop()
			this.defineProperty('__proxy__', { enumerable:false, configurable:true })
			// store it
			ONE.host.proxy_obj[this.__proxy__] = this
		}

		this._extendPost = function(){
			if(this == blockPrePost) return // make sure our current.extend doesnt trigger us
			this._proxify()
		}

		// the main property proxy on the worker side
		this._propertyProxy = function(name){
			if(this.__lookupSetter__(name)) return

			var store = '__' + name
			this[store] = this[name]

			if(!this.__lookupSetter__(name)) Object.defineProperty(this, name, {
				get:function(){
					return this[store]
				},
				set:function(v){
					var old = this[store]
					this[store] = v

					if(this.hasOwnProperty('__compilehash__')){
						// if we switch from value to astnode and back we need a recompile
						if(v && v.__proxy__ || old && old.__proxy__){
							return ONE.host.sendToHost({_type:'setref', _uid:this.__proxy__, name:name, value:v.__proxy__})
						}
						var recompile = false
						if(v && v._ast_){
							recompile = true
						}
						else if(old && old._ast_) recompile = true

						if(!recompile){
							if(typeof value !== 'object' || v._t_)
								return ONE.host.sendToHost({_type:'setvalue', _uid:this.__proxy__, name:name, value:v})
						}
						// line us up for reproxification
						if(!this._proxify_flag){
							this._proxify_flag = true
							if(ONE.proxify_list.push(this) == 1){
								setTimeout(ONE.proxify, 0)
							}
						}
					}
				}
			})
		}
		
		this._compilePropBinds = function(){
			var hasbinds = false
			var binds = this.proxy_refs
			var init = 'this._initBinds = function(){\n'
			var deinit = 'this._deinitBinds = function(){\n'
			for(var bind in binds){
				hasbinds = true
				var props = binds[bind]
				for(var prop in props){
					init += '\tthis._bindProp(this.'+bind+',"'+prop+'")\n'
					deinit += '\tthis._unbindProp(this.'+bind+',"'+prop+'")\n'
				}
			}
			if(!hasbinds) return ''
			init += '}\n'
			deinit += '}\n'
			// alright. how does this propertybinding crap look like.
			// alright so, we wanna bind to 
			return init+deinit
		}

		// proxify builds the message that spawns and updates proxified objects
		// on the host side.
		this._proxify = function(){
			// create a proxy id
			this._proxify_flag = false
			var proto = Object.getPrototypeOf(this)

			var isupdate = this.hasOwnProperty('__compilehash__')

			// iterate the keys we have
			var comp
			var msg = {_type:'proxify', _proto:proto.__proxy__, _uid:this.__proxy__}

			var hash = proto.__compilehash__ || ""

			var keys = Object.keys(this)
			var methods = ""

			for(var i = 0, l = keys.length; i < l; i++){
				var name = keys[i]
				var prop = this[name]
				var ch = name.charCodeAt(0)

				// make sure our property-settered values get forwarded
				if(ch == 95 && name.charCodeAt(1) == 95) name = name.slice(2), ch = 0

				if(ch == 36){ //$
					var base = name.slice(1)
					if(typeof prop == 'function'){ // execute
						if(!comp){
							comp = this.__compiles__ = Object.create(this.__compiles__ || null)	
						}
						hash += base + '={compile}\n'
						comp[base] = prop // store it
					}
					else if(prop._ast_){ // its a remote method
						var js = this.AST.ToJS
						js.new_state()
						js.module = prop.module
						methods += 'this.' + base + ' = ' + js.expand(prop) + '\n'
						//cache += base + '=' + prop.source + '\n'
					}
				}
				else if(ch != 95){ // doesnt start with _
					if(this['on_' + name]){ // we haz signal
						if(!msg._sigs) msg._sigs = []
						msg._sigs.push(name)
						msg[name] = this['__' + name].value
					}
					else
					if(prop && typeof prop == 'object'){
						if(prop.__proxy__){
							if(!msg._refs) msg._refs = []
							msg[name] = prop.__proxy__
							msg._refs.push(name)
							this._propertyProxy(name)
						}
						else if(prop._t_){ // only copy typed properties
							this._propertyProxy(name)
							// make a value-forward getter-setter
							msg[name] = prop
							var proto_prop = proto[name]
							if(proto_prop !== undefined && (!proto_prop._t_ || proto_prop._t_.name != prop._t_.name)){
								throw new Error('Error, cannot change type from baseclass property '+name+' my type: ' + prop._t_.name)
							}
							else hash += name + '=' + prop._t_.name + prop._t_.slots + '\n'
						}
						else if(prop._ast_){ // we found an expression, include it in our compile cache key
							var locals = prop.locals
							for(var local_name in locals){
								// we have to make sure the right thing goes in
								var local_val = locals[local_name]
								if(local_val && local_val.__proxy__){
									msg[local_name] = local_val.__proxy__
									msg._refs.push(local_name)
								}
								else{
									msg[local_name] = local_val
								}
							}
							// Todo: do storing context values here so we can cache compiles
							// make a recompile-triggering getter-setter
							this._propertyProxy(name)
							hash += name + '=' + prop.source + '\n'
						}
					}
					else if(typeof prop != 'function'){
						// make a value-forward getter-setter
						this._propertyProxy(name)
						var proto_prop = proto[name]
						if(proto_prop && proto_prop._ast_) 
							hash += name + '=#\n'
						msg[name] = prop
					}
				}
			}
			this.__compilehash__ = hash
			// we do have to 
			// only compile things if we are an instance
			if(!this.hasOwnProperty('__class__')){
				// lets first check if we actually need to compile by comparing
				// our __compilehash__ with our prototype chain
				// ok so what do we need
				if( hash && ((this.__compilehash__ && hash !== this.__compilehash__) || 
					hash !== proto.__compilehash__ || !proto.__compiled__)){

					this.proxy_refs = Object.create(null)
					// WARNING. we might need more strict rules on compiler cache, but lets try it
					var code = this.__proxy_cache__[hash] || ''

					if(!code){
						var dt = Date.now()
						var comp = this.__compiles__
						for(var name in comp){
							var prop = comp[name]
							code += prop.call(this) + '\n'
						}
						code += this._compilePropBinds()
						this.__proxy_cache__[hash] = code
					}
					//else console.log('code cache hit!')

					// TODO fix compile caching based on hash
					if(code){
						
						// ok we have code. now we check if we can place it higher up the prototype chain
						var last
						while(proto && proto.__compilehash__ == hash){
							//console.log('movin it up on ', this.__proxy__)
							last = proto
							proto = Object.getPrototypeOf(proto)
						}

						if(last){ // lets store it on last
							last.__compiled__ = true
							ONE.host.sendToHost({_type:'proxify', _uid:last.__proxy__,  _code:code})
						}
						else{
							this.__compiled__ = true
							msg._code = code
						}
					}
				}
			}
			else msg.__class__ = 'Host - '+this.__class__
			this.__compilehash__ = hash
			msg._code = msg._code?msg._code + methods:methods

			// ok we first send our object with codehash
			ONE.host.sendToHost(msg)
		}

		this.callHost = function(name){
			if(arguments.length > 1){
				ONE.host.sendToHost({_type:"call", name:name, _uid: this.__proxy__, args:Array.prototype.slice.call(arguments,1)})
			}
			else ONE.host.sendToHost({_type:"call", name:name, _uid: this.__proxy__})
		}

		this.hideProperties(Object.keys(this))
	})


	// the baseclass for the host objects
	this.Base.HostProxy = this.Base.extend(function(){
		
		this.__proxy_module__ = {}
		this.__proxy_cache__ = {}
		this.__class__ = 'HostProxy'
		this._getsetSig = function(name, worker){
			var store = '__' + name
			this[store] = this[name]

			this.defineProperty(name, {
				get:function(){
					return this[store]
				},
				set:function(v){
					this[store] = v
					// lets forward this
					
				}
			})
		}

		this._bindProp = function(obj, prop, worker){

			// what does that look like?
			var bind_store = '_bind_' + prop
			var store = '__' + prop

			if(Array.isArray(obj)){ // we are a late bind
				obj.push(this, null, prop)
				return
			}

			if(obj !== this){
				if(obj[bind_store]){
					obj[bind_store].push(this)
				}
				else{
					obj[bind_store] = [this]
				}
			}

			if(!obj.__lookupSetter__(prop)){
				// store old value
				obj[store] = obj[prop]
				if(typeof obj !='object') throw new Error('not object')
				Object.defineProperty(obj, prop, {
					get:function(){
						return this[store]
					},
					set:function(v){
						var old = this[store]
						if(old !== v){ // only forward on change
							this[store] = v
							var arr = this[bind_store]
							if(arr) for(var i = 0, l = arr.length; i < l; i++){
								var node = arr[i]
								if(node.flagDirty) node.flagDirty()
							}
						}
						if(worker) worker.sendToWorker({_type:'signal', _uid:this.__proxy__, name:prop, value:v})
					}
				})
			}
		}

		this._unbindProp = function(obj, prop){
			var bind_store = '_bind_' + prop
			var arr = obj[bind_store]
			var i
			if(!Array.isArray(arr) || (i = arr.indexOf(this)) == -1){
				console.log('Unbind property error ' + prop)
				return
			}
			arr.splice(i, 1)
		}

		this.hasBinds = function(prop){
			var arr = this['_bind_' + prop]
			if(!arr || !arr.length) return false
			return true
		}

		this._initFrom = function(msg, worker, isupdate){
			var msg_uid = this.__proxy__ = msg._uid

			if(isupdate){
				if(this._cleanup) this._cleanup()
				if(this._deinitBinds) this._deinitBinds()
			}

			// copy stuff from msg
			for(var k in msg){
				if(k.charCodeAt(0) != 95){
					// store it
					this[k] = msg[k]
				}
			}

			// define signal forwards
			var sigs = msg._sigs
			if(sigs){
				for(var i = 0, l = sigs.length; i < l; i++){
					this._bindProp(this, sigs[i], worker)
				}
			}

			var refs = msg._refs
			if(refs){
				for(var i = 0, l = refs.length; i < l; i++){
					var name = refs[i]
					var uid = this[name]
					if(typeof uid == 'number'){ // we need to resolve it
						var obj = worker.proxy_obj[uid]
						if(obj && !Array.isArray(obj)) this[name] = obj
						else{
							// make late resolve array
							var arr =  obj || (worker.proxy_obj[uid] = [])
							arr.push(this, name)
							this[name] = arr
						}
					}
				}
			}

			if(msg._code){
				// do some caching
				var fn = this.__proxy_cache__[msg._code] || 
						(this.__proxy_cache__[msg._code] = Function('module', msg._code))
				// execute on self to populate class
				fn.call(this, this.__proxy_module__)
			}

			// call init
			if(msg.__class__) this.__class__ = msg.__class__

			if(!this.hasOwnProperty('__class__')){
				if(!isupdate && this.init) this.init()
				if(this._initBinds) this._initBinds()
			}
		}
	})


}

ONE._createWorker = function(){
	var dt = Date.now()
	var source =
		'\nONE = {}' +
		'\nvar Assert'+
		'\nONE.init = ' + ONE.init.toString() +
		'\nONE.init_ast = ' + ONE.init_ast.toString() +
		'\nONE.base_ = ' + ONE.base_.toString() +
		'\nONE.proxy_ = ' + ONE.proxy_.toString() +
		'\nONE.ast_ = ' + ONE.ast_.toString() +
		'\nONE.genjs_ = ' + ONE.genjs_.toString() +
		'\nONE.genjs_compat_ = ' + ONE.genjs_compat_.toString() +
		'\nONE.color_ = ' + ONE.color_.toString() +
		'\nONE.parser_strict_ = ' + ONE.parser_strict_.toString() +
		'\nONE.worker_boot_ = ' + ONE.worker_boot_.toString() +
		'\nONE.worker_boot_(self)'

	var blob = new Blob([source], { type: "text/javascript" })
	this._worker_url = URL.createObjectURL(blob)
	var worker = new Worker(this._worker_url)
	return worker
}

// Bootstrap code for the browser, started at the bottom of the file
ONE.browser_boot_ = function(){

	var fake_worker = true
	var worker
	
	// fake worker for debugging
	if(fake_worker){
		worker = {
			postMessage: function(msg){
				host.onmessage({data:msg})
			},
			onmessage:function(){}
		}
		var host = {
			postMessage: function(msg){
				worker.onmessage({data:msg})
			},
			onmessage: function(){}
		}
		ONE.worker_boot_(host)
	}
	else worker = ONE._createWorker()

	worker.proxy_cache = {}
	worker.proxy_obj = {}
	var dt = 0

	worker.msg_start = 0
	worker.msg_queue = []

	worker.msgFlush = function(){
		var msgs = this.msg_queue
		this.msg_start = Date.now()
		this.msg_queue = []
		this.postMessage(msgs)
	}.bind(worker)

	worker.sendToWorker = function(msg){
		var now = Date.now()
		if(this.msg_queue.length && now - this.msg_start > 10){ // make sure we chunk every 20ms for parallelisation
			this.msg_queue.push(msg)
			this.msgFlush()
		}
		else{
			if(this.msg_queue.push(msg) == 1){
				this.msg_start = now
				setTimeout(this.msgFlush, 0)
			}
		}
	}

	var proxy_module = {
		worker:worker
	}

	worker.onmessage = function(event){
		var data = event.data
		// we have to create an object
		if(Array.isArray(data)){

			for(var i = 0, l = data.length;i < l;i++){
				var msg = data[i]

				if(msg._type == 'setref'){
					var on_obj = this.proxy_obj[msg._uid]
					if(!on_obj) throw new Error('Ref set on nonexistant object ' + msg._uid)
					var tgt_obj = this.proxy_obj[msg.value]
					if(!tgt_obj || Array.isArray(tgt_obj)){ // make late resolve array
						var arr =  tgt_obj || (this.proxy_obj[msg.value] = [])
						arr.push(on_obj, msg.name)						
					}
					else{
						on_obj[msg.name] = tgt_obj
					}
					if(on_obj.flagDirty) on_obj.flagDirty()
				}
				if(msg._type == 'setvalue'){
					var obj = this.proxy_obj[msg._uid]
					if(!obj) throw new Error('Value set on nonexistant object ' + msg._uid)
					obj[msg.name] = msg.value
					if(obj.flagDirty) obj.flagDirty()
				}
				else if(msg._type == 'call'){
					var obj = this.proxy_obj[msg._uid]
					if(!obj) throw new Error('Call on nonexistant object ' + msg._uid)
					obj[msg.name].call(obj, msg.args)
				}
				if(msg._type == 'proxify'){
					// lets check our 
					var old_obj = this.proxy_obj[msg._uid]
					var obj
					// clean up late resolve
					if(old_obj && !Array.isArray(old_obj)){
						//console.log('update!')
						if(!old_obj.hasOwnProperty('__class__') && old_obj.flagDirty) old_obj.flagDirty()
						obj = old_obj
	
						obj._initFrom(msg, worker, true)
					}
					else{
						if(msg._proto == 0) obj = ONE.Base.HostProxy.new()
						else obj = Object.create(this.proxy_obj[msg._proto])
						this.proxy_obj[msg._uid] = obj

						obj._initFrom(msg, worker, false)

						// do all late binds
						if(Array.isArray(old_obj)){
							for(var j = 0, k = old_obj.length; j < k; ){
								var tgt_obj = old_obj[j]
								var name = old_obj[j+1]
								if(name == null){ // its a late property bind
									name = old_obj[j+2]
									tgt_obj._bindProp(obj, name)
									j += 3
								}
								else{ // its a late reference resolve
									tgt_obj[name] = obj
									j += 2
								}
							}
						}
					}
				}
			}
		}
	}

	if(!fake_worker) ONE.init()

	function module_get( url, module ){
		return ONE.Base.wrapSignal(function(sig){
			var elem = document.getElementById(module)
			if(elem){
				var value = elem.innerHTML
				worker.sendToWorker({_type:'parse', module:module, value:value})
				return sig.end(value)
			}
			// do some XMLHTTP
			var pthis = this
			var req = new XMLHttpRequest()
			req.open("GET",url,true)
			req.onreadystatechange = function(){
				if(req.readyState == 4){
					if(req.status != 200) return sig.throw(req.status)
					var value = req.responseText
					worker.sendToWorker({_type:'parse', module:module, value:value})
					return sig.end(value)
				}
			}
			req.send()
		})
	}
	
	var type = "main"
	var root

	if(location.hash){
		root = location.hash.slice(1)
		var hack = location.hash.indexOf('?')
		if(hack !== -1) root = root.slice(0,hack-1)
	}
	else root = type
	
	function init(){

		var loader = {}
		// when do we resolve a module? when all its deps have been loaded.
		function load_dep( module ){
			// lets load a module
			return ONE.Base.wrapSignal(function(sig){
				var url = module + '.n'
				var data_sig = loader[module]
				var first = false
				if(!data_sig){
					first = true
					data_sig = loader[module] = module_get(url, module)
				}
				// otherwise we only resolve sig
				data_sig.then(function(value){
					// okay lets scan for our dependencies
					var all = []
					value.replace(/import\s+(\w+)/g, function(m, mod){
						all.push(load_dep(mod))
					})
					ONE.Base.allSignals(all).then(function(){
						if(first) worker.sendToWorker({_type:'eval', module:module})
						else first = false
						sig.end()
					}, 
					function(err){
						sig.throw(err)
					})
				}, 
				function(err){
					sig.throw(err)	
				})
			})
		}
		
		load_dep(root).then(function(){
			worker.sendToWorker({_type:'run', module:root})	
		})
	}
	if(location.hostname.match(/(.*?)\.onejs\.io/)){
		// we are packed, wait 
		window.addEventListener("load", init)
	}
	else {
		init()
	}

	// initialize ONEJS also on the main thread	
	if(!fake_worker) ONE.init_ast()
	if(location.hash) ONE.reloader()
		
	window.onerror = function(msg, url, line) {
		var name = url.match(/[^\/]*$/)[0]
		ONE.error(msg + ' in '+name+' line '+line)
		return false
	}
} 

ONE.browser_boot_()