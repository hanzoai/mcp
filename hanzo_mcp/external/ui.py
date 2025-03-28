"""UI for managing external MCP servers."""

import asyncio
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from typing import Dict, List, Optional, Any

from hanzo_mcp.external.config_manager import MCPServerConfig
from hanzo_mcp.external.registry import MCPServerRegistry
from hanzo_mcp.external.mcp_manager import ExternalMCPServerManager


def run_management_ui() -> None:
    """Launch the MCP Server Management UI."""
    root = tk.Tk()
    root.title("Hanzo MCP - Server Manager")
    root.geometry("700x500")
    
    # Initialize config and registry
    config = MCPServerConfig()
    registry = MCPServerRegistry()
    manager = ExternalMCPServerManager()
    
    # Create status bar
    status_var = tk.StringVar()
    status_var.set("Ready")
    status_bar = tk.Label(root, textvariable=status_var, bd=1, relief=tk.SUNKEN, anchor=tk.W)
    status_bar.pack(side=tk.BOTTOM, fill=tk.X)
    
    # Create tabs
    tab_control = ttk.Notebook(root)
    
    installed_tab = ttk.Frame(tab_control)
    registry_tab = ttk.Frame(tab_control)
    
    tab_control.add(installed_tab, text='Installed Servers')
    tab_control.add(registry_tab, text='Server Registry')
    tab_control.pack(expand=1, fill="both")
    
    # INSTALLED SERVERS TAB
    
    # Auto-detect frame
    auto_detect_frame = ttk.Frame(installed_tab)
    auto_detect_frame.pack(fill="x", padx=10, pady=5)
    
    auto_detect_var = tk.BooleanVar(value=config.get_auto_detect())
    auto_detect_cb = ttk.Checkbutton(
        auto_detect_frame, 
        text="Auto-detect installed servers", 
        variable=auto_detect_var,
        command=lambda: config.set_auto_detect(auto_detect_var.get())
    )
    auto_detect_cb.pack(side="left", padx=5)
    
    refresh_installed_btn = ttk.Button(
        auto_detect_frame,
        text="Refresh",
        command=lambda: load_installed_servers(server_tree, config, manager)
    )
    refresh_installed_btn.pack(side="right", padx=5)
    
    # Servers treeview with scrollbar
    server_frame = ttk.Frame(installed_tab)
    server_frame.pack(fill="both", expand=True, padx=10, pady=5)
    
    columns = ('name', 'status', 'command')
    server_tree = ttk.Treeview(server_frame, columns=columns, show='headings')
    
    server_tree.heading('name', text='Server')
    server_tree.heading('status', text='Status')
    server_tree.heading('command', text='Command')
    
    server_tree.column('name', width=100)
    server_tree.column('status', width=80)
    server_tree.column('command', width=400)
    
    scrollbar = ttk.Scrollbar(server_frame, orient=tk.VERTICAL, command=server_tree.yview)
    server_tree.configure(yscroll=scrollbar.set)
    
    server_tree.pack(side=tk.LEFT, fill="both", expand=True)
    scrollbar.pack(side=tk.RIGHT, fill="y")
    
    # Buttons frame
    button_frame = ttk.Frame(installed_tab)
    button_frame.pack(fill="x", padx=10, pady=5)
    
    enable_btn = ttk.Button(
        button_frame, 
        text="Enable", 
        command=lambda: toggle_server(server_tree, config, manager, status_var, True)
    )
    disable_btn = ttk.Button(
        button_frame, 
        text="Disable", 
        command=lambda: toggle_server(server_tree, config, manager, status_var, False)
    )
    
    enable_btn.pack(side="left", padx=5)
    disable_btn.pack(side="left", padx=5)
    
    # REGISTRY TAB
    
    # Search frame
    search_frame = ttk.Frame(registry_tab)
    search_frame.pack(fill="x", padx=10, pady=5)
    
    search_label = ttk.Label(search_frame, text="Search:")
    search_label.pack(side="left", padx=5)
    
    search_var = tk.StringVar()
    search_entry = ttk.Entry(search_frame, textvariable=search_var)
    search_entry.pack(side="left", fill="x", expand=True, padx=5)
    
    search_btn = ttk.Button(
        search_frame, 
        text="Search", 
        command=lambda: filter_registry(registry_tree, registry, search_var.get(), status_var)
    )
    search_btn.pack(side="left", padx=5)
    
    update_btn = ttk.Button(
        search_frame, 
        text="Update Registry", 
        command=lambda: update_registry_ui(registry_tree, registry, status_var)
    )
    update_btn.pack(side="right", padx=5)
    
    # Registry treeview with scrollbar
    registry_frame = ttk.Frame(registry_tab)
    registry_frame.pack(fill="both", expand=True, padx=10, pady=5)
    
    r_columns = ('id', 'name', 'description', 'command')
    registry_tree = ttk.Treeview(registry_frame, columns=r_columns, show='headings')
    
    registry_tree.heading('id', text='ID')
    registry_tree.heading('name', text='Name')
    registry_tree.heading('description', text='Description')
    registry_tree.heading('command', text='Command')
    
    registry_tree.column('id', width=100)
    registry_tree.column('name', width=100)
    registry_tree.column('description', width=200)
    registry_tree.column('command', width=180)
    
    r_scrollbar = ttk.Scrollbar(registry_frame, orient=tk.VERTICAL, command=registry_tree.yview)
    registry_tree.configure(yscroll=r_scrollbar.set)
    
    registry_tree.pack(side=tk.LEFT, fill="both", expand=True)
    r_scrollbar.pack(side=tk.RIGHT, fill="y")
    
    # Install button
    install_frame = ttk.Frame(registry_tab)
    install_frame.pack(fill="x", padx=10, pady=5)
    
    install_btn = ttk.Button(
        install_frame, 
        text="Install Selected", 
        command=lambda: install_selected(registry_tree, registry, config, manager, server_tree, status_var)
    )
    install_btn.pack(side="right", padx=5)
    
    # Helper functions for UI
    def toggle_server(tree, config, manager, status_var, enable):
        selected = tree.selection()
        if not selected:
            status_var.set("Error: No server selected")
            return
            
        server_id = tree.item(selected[0])['values'][0]
        
        if enable:
            config.enable_server(server_id)
            status_var.set(f"Server '{server_id}' enabled")
        else:
            config.disable_server(server_id)
            status_var.set(f"Server '{server_id}' disabled")
            
        # Reload the server manager
        manager._load_servers()
        load_installed_servers(tree, config, manager)
    
    def load_installed_servers(tree, config, manager):
        # Clear existing items
        for item in tree.get_children():
            tree.delete(item)
            
        # Add servers from config
        for server_id, server_config in config.get_all_servers().items():
            enabled = server_config.get("enabled", True)
            command = f"{server_config.get('command', '')} {' '.join(server_config.get('args', []))}"
            
            tree.insert('', tk.END, values=(
                server_id,
                "Enabled" if enabled else "Disabled",
                command
            ))
            
        # Also check running servers
        for server in manager.get_enabled_servers():
            running = "Running" if server.is_running() else "Stopped"
            # Check if this server is already in the tree
            found = False
            for item in tree.get_children():
                if tree.item(item)['values'][0] == server.name:
                    # Update the status
                    tree.item(item, values=(server.name, running, tree.item(item)['values'][2]))
                    found = True
                    break
            
            # If not found, add it
            if not found:
                tree.insert('', tk.END, values=(
                    server.name,
                    running,
                    f"{server.command} {' '.join(server.args)}"
                ))
    
    def filter_registry(tree, registry, query, status_var):
        # Clear existing items
        for item in tree.get_children():
            tree.delete(item)
            
        # Add filtered servers from registry
        servers = registry.search_servers(query)
        for server_id, info in servers.items():
            command = f"{info.get('command', '')} {' '.join(info.get('args', []))}"
            
            tree.insert('', tk.END, values=(
                server_id,
                info.get("name", server_id),
                info.get("description", ""),
                command
            ))
            
        status_var.set(f"Found {len(servers)} servers matching '{query}'")
    
    def update_registry_ui(tree, registry, status_var):
        status_var.set("Updating registry...")
        
        def _update():
            try:
                result = asyncio.run(registry.fetch_registry())
                if "error" in result:
                    root.after(0, lambda: status_var.set(f"Error updating registry: {result['error']}"))
                else:
                    root.after(0, lambda: status_var.set(f"Registry updated: {len(registry.get_servers())} servers available"))
                    root.after(0, lambda: filter_registry(tree, registry, "", status_var))
            except Exception as e:
                root.after(0, lambda: status_var.set(f"Error updating registry: {str(e)}"))
        
        # Run in a thread to avoid blocking UI
        threading.Thread(target=_update).start()
    
    def install_selected(tree, registry, config, manager, server_tree, status_var):
        selected = tree.selection()
        if not selected:
            status_var.set("Error: No server selected")
            return
            
        server_id = tree.item(selected[0])['values'][0]
        status_var.set(f"Installing {server_id}...")
        
        def _install():
            try:
                success = asyncio.run(registry.install_server(server_id, config))
                if success:
                    root.after(0, lambda: status_var.set(f"Server '{server_id}' installed successfully"))
                    # Reload server manager and update the server tree
                    manager._load_servers()
                    root.after(0, lambda: load_installed_servers(server_tree, config, manager))
                else:
                    root.after(0, lambda: status_var.set(f"Failed to install server '{server_id}'"))
            except Exception as e:
                root.after(0, lambda: status_var.set(f"Error installing server: {str(e)}"))
        
        # Run in a thread to avoid blocking UI
        threading.Thread(target=_install).start()
    
    # Initialize UI
    load_installed_servers(server_tree, config, manager)
    filter_registry(registry_tree, registry, "", status_var)
    
    # Bind events
    # Double-click on registry item shows details
    def show_server_details(event):
        selected = registry_tree.selection()
        if not selected:
            return
            
        server_id = registry_tree.item(selected[0])['values'][0]
        server_info = registry.get_servers().get(server_id, {})
        
        details_window = tk.Toplevel(root)
        details_window.title(f"Server Details: {server_id}")
        details_window.geometry("500x300")
        
        details_frame = ttk.Frame(details_window, padding=10)
        details_frame.pack(fill="both", expand=True)
        
        # Server details
        ttk.Label(details_frame, text=f"ID: {server_id}", font=("", 12, "bold")).grid(row=0, column=0, sticky="w", pady=5)
        ttk.Label(details_frame, text=f"Name: {server_info.get('name', server_id)}").grid(row=1, column=0, sticky="w", pady=2)
        ttk.Label(details_frame, text=f"Description: {server_info.get('description', '')}").grid(row=2, column=0, sticky="w", pady=2)
        
        command = f"{server_info.get('command', '')} {' '.join(server_info.get('args', []))}"
        ttk.Label(details_frame, text=f"Command: {command}").grid(row=3, column=0, sticky="w", pady=2)
        
        if "homepage" in server_info:
            ttk.Label(details_frame, text=f"Homepage: {server_info['homepage']}").grid(row=4, column=0, sticky="w", pady=2)
            
        # Buttons
        button_frame = ttk.Frame(details_frame)
        button_frame.grid(row=5, column=0, sticky="e", pady=10)
        
        install_btn = ttk.Button(
            button_frame,
            text="Install",
            command=lambda: [
                asyncio.run(registry.install_server(server_id, config)),
                details_window.destroy(),
                load_installed_servers(server_tree, config, manager),
                status_var.set(f"Server '{server_id}' installed")
            ]
        )
        install_btn.pack(side="right", padx=5)
        
        close_btn = ttk.Button(
            button_frame,
            text="Close",
            command=details_window.destroy
        )
        close_btn.pack(side="right", padx=5)
    
    registry_tree.bind("<Double-1>", show_server_details)
    
    # Start the UI
    status_var.set("Ready - Hanzo MCP Server Manager")
    root.mainloop()


def main() -> None:
    """Run the MCP server management UI."""
    run_management_ui()


if __name__ == "__main__":
    main()
