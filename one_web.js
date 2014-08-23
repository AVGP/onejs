"use strict"
// ONEJS Runtime
// Copyright (C) 2014 ONEJS 

ONE.worker_boot_ = function(host){

	host.onmessage = function(event){
		var msg = event.data
		if(msg._id == 'eval'){ // lets parse and eval a module
			var ast = ONE.root.$['_' + msg.module]
			var dt = Date.now()
			if(!ast){
				return console.log('Module ' + msg.module + ' not parsed')
			}
			ONE.root.$[msg.module] = ONE.root.eval(ast, msg.module)
			//console.log('eval '+msg.module+' '+(Date.now()-dt)+'ms')
			return
		}
		if(msg._id == 'parse'){
			var dt = Date.now()
			ONE.root.$['_' + msg.module] = ONE.root.parse('->{' + msg.value + '\n}', msg.module)
			//console.log('parse '+msg.module+' '+(Date.now()-dt)+'ms')
			return
		}
		if(msg._id == 'run'){
			ONE.root.$[msg.module].call(ONE.root)
			return
		}
	}

	ONE.proxy_flush = function(){
		host.postMessage(ONE.proxy_queue)
		ONE.proxy_start = Date.now()
		ONE.proxy_queue = []
	}

	ONE.proxy_init = function(){
		var dt = Date.now()
		var inits = ONE.proxy_inits
		ONE.proxy_inits = []
		for(var i = 0, l = inits.length; i<l; i++){
			inits[i].proxy_init()
		}
	}

	ONE.proxy_inits = []
	ONE.proxy_start = Date.now()
	ONE.proxy_queue = []
	ONE.proxy_uid = 1
	ONE.proxy_free = []
	ONE.init()
	ONE.init_ast()
	ONE.root = ONE.Base.new()
	ONE.root.__class__ = 'Root'
}

ONE.proxy_ = function(){
	// TODO proxy stuff
	this.proxy_hook = function(obj){
	}

	this.proxy_unhook = function(){
	}

	this.proxy_signal = function(pthis){
		for(var i = 1, l = arguments.length;i<l;i++){
			var sig = arguments[i]
		}
	}

	this.Base.Proxy = this.Base.extend(function(){
		this._init = function(){
			if(!ONE.proxy_free.length) this.proxy_uid = ONE.proxy_uid++
			else this.proxy_uid = ONE.proxy_free.pop()

			if(typeof this.init == 'function') this.init.call(this, arguments)
			// queue our object up for sending it over to the other side
			if(ONE.proxy_inits.push(this) == 1){
				setTimeout(ONE.proxy_init, 0)
			}
		}

		this.proxy_init = function(){
			var msg = {proxy_uid: this.proxy_uid}

			var src = this.proxy()

			// if our compiler created any objects, lets init them first
			// otherwise our dependencies cannot be met
			if(ONE.proxy_inits.length){
				var inits = ONE.proxy_inits
				ONE.proxy_inits = []
				for(var i = 0, l = inits.length; i<l; i++){
					inits[i].proxy_init()
				}
			}

			msg.proxy_code = src
			// transfer proxied properties
			var props = this.proxy_props
			if(props){
				for(var k in props){
					var v = this[k]
					if(v === undefined){
						throw new Error('Trying to proxy prop ' + k + ' but is undefined')
					}
					if(v && v._signal_) msg[k] = v.value
					else msg[k] = v
				}
			}
			// transfer proxied references
			var refs = this.proxy_refs
			if(refs){
				for(var k in refs){
					if(!this[k]) throw new Error('Trying to proxy ref ' + k + ' but is undefined')
					msg[k] = this[k].proxy_uid
				}
			}
			
			if(this.proxy_dump) msg.proxy_dump = 1

			// push the message in the queue
			var queue = ONE.proxy_queue
			var start = ONE.proxy_start
			var now = Date.now()
			if(now - start < 50){ // make sure we chunk every 50ms for parallelisation
				if(queue.push(msg) == 1){
					setTimeout(ONE.proxy_flush, 0)
				}
			}
			else{
				queue.push(msg)
				ONE.proxy_flush()
			}
		}
		
		this.proxy = function( methods ){
			if(!methods) methods = {init:this.init}

			var code = ''
			for(var key in methods){
				var method = methods[key]
				var proxy_code = method.proxy_code
				if(proxy_code){
					code += proxy_code
					continue
				}

				if(!method._ast_) throw new Error('invalid proxy method')
				var js = this.AST.ToJS
				js.new_state()
				js.module = method.module
				code += 'this.' + key + ' = ' + js.expand(method) + '\n'

				method.proxy_code = code
			}
			var refs = this.proxy_refs
			if(refs){
				for(var k in refs){
					code += 'var res = ONE.proxy_obj[this.' + k + ']\n'
					code += 'if(res === undefined) ONE.proxy_obj[this.' + k + '] = [this, "'+k+'"]\n'
					code += 'else if(Array.isArray(res)) res.push(this, "'+k+'")\n'
					code += 'else this.'+k+' = res\n'

				}
			}
			return code
		}

		this.proxyProp = function(){
			
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

	var fake_worker = false
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

	ONE.proxy_code = {}
	ONE.proxy_obj = {}
	var dt = 0
	worker.onmessage = function(event){
		var msg = event.data
		// we have to create an object
		if(Array.isArray(msg)){

			for(var i = 0, l = msg.length;i < l;i++){
				var obj = msg[i]

				var arr = ONE.proxy_obj[obj.proxy_uid]
				if(arr){
					for(var j = 0, m = arr.length; j<m; j+=2){
						arr[j][arr[j+1]] = obj
					}
				}
				ONE.proxy_obj[obj.proxy_uid] = obj

				if(obj.proxy_dump) console.log(obj)
				var code = obj.proxy_code
				var init = ONE.proxy_code[code]
				if(!init){
					try{
						init = ONE.proxy_code[code] = Function('module', code)
					}
					catch(e){
						console.log("Error in proxy_code ",e, code)
					}
				}
				// initialize object
				init.call(obj, {})
				if(obj.init) obj.init()
				//console.log(obj)
			}
		}
	}

	if(!fake_worker) ONE.init()

	function module_get( url, module ){
		return ONE.Base.wrapSignal(function(sig){
			var elem = document.getElementById(module)
			if(elem){
				var value = elem.innerHTML
				worker.postMessage({_id:'parse', module:module, value:value})
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
					worker.postMessage({_id:'parse', module:module, value:value})
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
						if(first) worker.postMessage({_id:'eval', module:module})
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
			worker.postMessage({_id:'run', module:root})	
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